import { platform } from "node:os";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type } from "arktype";
import { resolveDataPath } from "../glv/db-path.js";
import { isRecord, JsonObject, parseJson } from "../glv/parse.js";
import { placeholders, validate, validateAll } from "../glv/query.js";
import type {
  MessageRow,
  SessionFilter,
  SessionRow,
  SessionStore,
} from "../glv/sessions.js";

const sessionShape = {
  id: "string",
  name: "string",
  user_set_name: "number | null",
  description: "string",
  session_type: "string",
  working_dir: "string",
  created_at: "string",
  updated_at: "string",
  total_tokens: "number | null",
  provider_name: "string | null",
  archived_at: "string | null",
} as const;

const SessionRowModel = type(sessionShape);

const SESSION_COLS = Object.keys(sessionShape).join(", ");

const messageShape = {
  message_id: "string | null",
  session_id: "string",
  role: "string",
  content_json: "string",
  created_timestamp: "number",
  timestamp: "string",
} as const;

const MessageRowModel = type(messageShape);

const MESSAGE_COLS = Object.keys(messageShape).join(", ");

// goose's documented session storage differs by platform: the XDG data dir
// (~/.local/share/goose) on Unix, %APPDATA%\Block\goose\data on Windows
// (goose's "Session Records" guide). glv-owned databases are unaffected.
const DEFAULT_DB_SEGMENTS: readonly string[] =
  platform() === "win32"
    ? ["Block", "goose", "data", "sessions", "sessions.db"]
    : ["goose", "sessions", "sessions.db"];

const resolveDbPath = (override?: string): string =>
  resolveDataPath(override, "GOOSE_SESSIONS_DB", ...DEFAULT_DB_SEGMENTS);

const openDb = (
  dbPath: string,
  { readOnly = true }: { readOnly?: boolean } = {},
): DatabaseSync => {
  try {
    return new DatabaseSync(dbPath, { readOnly });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not open goose sessions database at ${dbPath}: ${detail}`,
    );
  }
};

// goose owns this schema and only creates it on its first run, so serve may
// boot against an empty database file. Reads degrade to empty results there —
// the viewer shows "no sessions" instead of 500-ing every route until goose
// has run once. Any other error still surfaces.
const isMissingTable = (err: unknown): boolean =>
  err instanceof Error && err.message.includes("no such table:");

const allRows = (
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): unknown[] => {
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return [];
  }
};

const getRow = (
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): unknown => {
  try {
    return db.prepare(sql).get(...params);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return undefined;
  }
};

const listSessions = (
  db: DatabaseSync,
  filter: SessionFilter,
): SessionRow[] => {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.type !== "all") {
    clauses.push("session_type = ?");
    params.push(filter.type);
  }
  if (!filter.includeArchived) clauses.push("archived_at IS NULL");
  const parts = [`SELECT ${SESSION_COLS} FROM sessions`];
  if (clauses.length > 0) parts.push(`WHERE ${clauses.join(" AND ")}`);
  parts.push("ORDER BY updated_at DESC", "LIMIT ?");
  params.push(filter.limit);
  // The sidebar never renders the model, so listing skips the extra
  // readModelName query; the detail pane re-reads the row via getSession.
  return validateAll(
    SessionRowModel,
    allRows(db, parts.join(" "), ...params),
  ).map((row) => ({ ...row, model: null }));
};

// goose records the model a session ran with on its row, as
// model_config_json — {"model_name": ...} — rather than a plain column.
// The column postdates some goose schemas and the database is agent-owned,
// so any read or parse failure degrades to "no model known"; the header
// simply omits the chip.
const readModelName = (db: DatabaseSync, id: string): string | null => {
  try {
    const row = db
      .prepare("SELECT model_config_json FROM sessions WHERE id = ?")
      .get(id);
    if (!isRecord(row) || typeof row.model_config_json !== "string")
      return null;
    const parsed = parseJson(row.model_config_json, JsonObject);
    if (!parsed.ok) return null;
    const name = parsed.data.model_name;
    return typeof name === "string" && name !== "" ? name : null;
  } catch {
    return null;
  }
};

const getSession = (db: DatabaseSync, id: string): SessionRow | undefined => {
  const row = validate(
    SessionRowModel,
    getRow(db, `SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`, id),
  );
  return row === undefined
    ? undefined
    : { ...row, model: readModelName(db, id) };
};

// goose appends each turn's context right after its prompt and the rows
// can share a timestamp; the rowid tiebreak preserves insertion order.
const listMessages = (db: DatabaseSync, sessionId: string): MessageRow[] =>
  validateAll(
    MessageRowModel,
    allRows(
      db,
      `SELECT ${MESSAGE_COLS} FROM messages
           WHERE session_id = ?
           ORDER BY created_timestamp ASC, id ASC`,
      sessionId,
    ),
  );

const IdRow = type({ id: "string" });

// Lets the new-session poll distinguish a freshly created session from
// pre-existing ones in the same working dir. Selects only `id` with a lenient
// schema so a half-written row still matches.
const sessionIdsInDir = (db: DatabaseSync, workingDir: string): string[] =>
  validateAll(
    IdRow,
    allRows(db, "SELECT id FROM sessions WHERE working_dir = ?", workingDir),
  ).map((row) => row.id);

const archiveSessions = (db: DatabaseSync, ids: string[]): void => {
  if (ids.length === 0) return;
  db.prepare(
    `UPDATE sessions SET archived_at = CURRENT_TIMESTAMP
       WHERE id IN (${placeholders(ids.length)}) AND archived_at IS NULL`,
  ).run(...ids);
};

// A blank name clears the user-set flag.
const renameSession = (db: DatabaseSync, id: string, rawName: string): void => {
  const name = rawName.trim();
  db.prepare(
    "UPDATE sessions SET name = ?, user_set_name = ? WHERE id = ?",
  ).run(name, name === "" ? 0 : 1, id);
};

// Cheap pre-filter for sidebar PR detection: only sessions whose raw message
// content references a GitHub pull URL can resolve to a PR, so callers skip
// parsing messages for the rest. Validates each row (half-written rows drop).
const PrIdRow = type({ session_id: "string" });

const prCandidateIds = (db: DatabaseSync, ids: string[]): Set<string> => {
  if (ids.length === 0) return new Set();
  const rows = validateAll(
    PrIdRow,
    db
      .prepare(
        `SELECT DISTINCT session_id FROM messages
           WHERE session_id IN (${placeholders(ids.length)})
             AND content_json LIKE ?`,
      )
      .all(...ids, "%/pull/%"),
  );
  return new Set(rows.map((row) => row.session_id));
};

// Used to name a freshly created group after its founding session — the one
// whose first user prompt came earliest. `undefined` when none of the
// sessions have a user message yet.
const firstPromptSessionName = (
  db: DatabaseSync,
  ids: string[],
): string | undefined => {
  if (ids.length === 0) return undefined;
  const row = validate(
    type({ session_id: "string" }),
    db
      .prepare(
        `SELECT session_id FROM messages
           WHERE session_id IN (${placeholders(ids.length)})
             AND role = 'user'
           GROUP BY session_id
           ORDER BY MIN(created_timestamp) ASC
           LIMIT 1`,
      )
      .get(...ids),
  );
  return row === undefined ? undefined : getSession(db, row.session_id)?.name;
};

// The goose storage adapter: browsing stays read-only so it never touches a
// row a live goose session is writing; viewer-managed archive/rename
// mutations go through the writable handle.
const createSessionStore = (
  db: DatabaseSync,
  dbWritable: DatabaseSync,
): SessionStore => ({
  listSessions: (filter) => listSessions(db, filter),
  getSession: (id) => getSession(db, id),
  listMessages: (sessionId) => listMessages(db, sessionId),
  archiveSessions: (ids) => archiveSessions(dbWritable, ids),
  renameSession: (id, rawName) => renameSession(dbWritable, id, rawName),
  firstPromptSessionName: (ids) => firstPromptSessionName(db, ids),
  prCandidateIds: (ids) => prCandidateIds(db, ids),
});

export {
  createSessionStore,
  getSession,
  openDb,
  resolveDbPath,
  sessionIdsInDir,
};
