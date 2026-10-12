import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type } from "arktype";
import { resolveDataPath } from "../glv/db-path.js";
import { isRecord, JsonObject, parseJson } from "../glv/parse.js";
import { placeholders, validate, validateAll } from "../glv/query.js";
import type {
  ForkResult,
  MessageRow,
  SessionFilter,
  SessionRow,
  SessionStore,
} from "../glv/sessions.js";
import { forkSessionName } from "../glv/sessions.js";

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

// The handle pair serve opens: writable first — read-only mode cannot
// create the file, so serve works before goose has ever run — with both
// handles waiting out a concurrent goose write, because node:sqlite's
// default busy timeout is 0 (fail at once), which the sidebar,
// transcript, and launch-poll reads must outlive.
const openServeDbs = (
  override?: string,
): {
  readonly db: DatabaseSync;
  readonly dbWritable: DatabaseSync;
} => {
  const dbPath = resolveDbPath(override);
  const dbWritable = openDb(dbPath, { readOnly: false });
  dbWritable.exec("PRAGMA busy_timeout=5000");
  const db = openDb(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  return { db, dbWritable };
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
  parts.push("ORDER BY updated_at DESC", "LIMIT ? OFFSET ?");
  params.push(filter.limit, filter.offset ?? 0);
  // The sidebar never renders the model, so listing skips the extra
  // readModelName query; the detail pane re-reads the row via getSession.
  return validateAll(
    SessionRowModel,
    allRows(db, parts.join(" "), ...params),
  ).map((row) => ({ ...row, model: null }));
};

// goose records the model a session ran with on the session row, inside
// model_config_json ({"model_name": ...}) rather than a plain column.
const parseModelName = (configJson: string): string | null => {
  const parsed = parseJson(configJson, JsonObject);
  if (!parsed.ok) return null;
  const name = parsed.data.model_name;
  return typeof name === "string" && name !== "" ? name : null;
};

const readModelConfig = (db: DatabaseSync, id: string): string | null => {
  const row = db
    .prepare("SELECT model_config_json FROM sessions WHERE id = ?")
    .get(id);
  if (!isRecord(row) || typeof row.model_config_json !== "string") return null;
  return row.model_config_json;
};

// The column postdates some goose schemas and the database is agent-owned,
// so any read or parse failure degrades to "no model known" — the header
// simply omits the chip.
const readModelName = (db: DatabaseSync, id: string): string | null => {
  try {
    const config = readModelConfig(db, id);
    return config === null ? null : parseModelName(config);
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

// Unlike archive, the rows are deleted outright so the session is neither
// listable nor recoverable. secure_delete zeroes the freed pages as they
// go, and the truncating checkpoint drains the -wal sidecar so committed
// copies don't linger on disk.
const deleteSessions = (db: DatabaseSync, ids: string[]): void => {
  if (ids.length === 0) return;
  db.exec("PRAGMA secure_delete = ON");
  const marks = placeholders(ids.length);
  db.prepare(`DELETE FROM messages WHERE session_id IN (${marks})`).run(...ids);
  db.prepare(`DELETE FROM sessions WHERE id IN (${marks})`).run(...ids);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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

// goose owns this schema and drifts it over releases (schema_version 17
// today), so a fork copies whatever columns exist rather than a hardcoded
// list: the session row's shape is discovered from PRAGMA table_info at
// runtime. Column names are validated as plain identifiers before they
// reach SQL — the database is agent-owned, not glv's.
const PragmaColumn = type({ name: "string" });
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const tableColumns = (db: DatabaseSync, table: string): string[] =>
  validateAll(PragmaColumn, db.prepare(`PRAGMA table_info(${table})`).all())
    .map((row) => row.name)
    .filter((name) => IDENTIFIER.test(name));

// Columns a fork rewrites rather than copies: the fresh id, the fork name
// (user-set), a now updated_at, and a visible (unarchived) row. The order
// pairs with the selectRefs below.
const SESSION_FORK_OVERWRITE_ORDER: readonly string[] = [
  "id",
  "name",
  "user_set_name",
  "updated_at",
  "archived_at",
];
const SESSION_FORK_OVERWRITE: ReadonlySet<string> = new Set(
  SESSION_FORK_OVERWRITE_ORDER,
);

// The (created_timestamp, id) pair of the message at `cutoff` — the index
// into the exact order listMessages reads (created_timestamp ASC, id ASC).
// `undefined` when the index is past the transcript's end.
const CutoffRow = type({
  id: "number",
  created_timestamp: "number",
});

const cutoffBoundary = (
  db: DatabaseSync,
  sessionId: string,
  cutoff: number,
): { readonly id: number; readonly createdTimestamp: number } | undefined => {
  const row = validate(
    CutoffRow,
    db
      .prepare(
        "SELECT id, created_timestamp FROM messages WHERE session_id = ? " +
          "ORDER BY created_timestamp ASC, id ASC LIMIT 1 OFFSET ?",
      )
      .get(sessionId, cutoff),
  );
  return row === undefined
    ? undefined
    : { id: row.id, createdTimestamp: row.created_timestamp };
};

// Copies a session under a fresh id in one transaction: the session row and
// the messages up to the cutoff, by the same (created_timestamp, id) order
// the transcript reads. The usage_ledger table stays untouched (matching
// goose's own fork — a fork's stats start clean), and parent provenance
// lands in parent_session_id when the goose schema has the column (17
// does). The source is only ever read.
const forkSession = (
  dbWritable: DatabaseSync,
  sourceId: string,
  cutoff: number | null,
): ForkResult => {
  const fail = (status: number, error: string): ForkResult => ({
    ok: false,
    status,
    error,
  });

  const name = validate(
    type({ name: "string" }),
    getRow(dbWritable, "SELECT name FROM sessions WHERE id = ?", sourceId),
  )?.name;
  if (name === undefined) return fail(404, `No session ${sourceId}.`);

  const forkId = randomUUID();

  const sessionCols = tableColumns(dbWritable, "sessions");
  if (sessionCols.length === 0) return fail(404, `No session ${sourceId}.`);
  const hasParentColumn = sessionCols.includes("parent_session_id");
  const copyCols = sessionCols.filter(
    (col) => !SESSION_FORK_OVERWRITE.has(col) && col !== "parent_session_id",
  );
  const insertCols = [
    ...SESSION_FORK_OVERWRITE_ORDER,
    ...(hasParentColumn ? ["parent_session_id"] : []),
    ...copyCols,
  ];
  const selectRefs = [
    "?",
    "?",
    "1",
    "datetime('now')",
    "NULL",
    ...(hasParentColumn ? ["?"] : []),
    ...copyCols,
  ];

  const boundary =
    cutoff === null ? undefined : cutoffBoundary(dbWritable, sourceId, cutoff);
  if (cutoff !== null && boundary === undefined)
    return fail(
      422,
      `Cutoff ${cutoff} is past the end of the session's transcript.`,
    );

  const messageCols = tableColumns(dbWritable, "messages");
  // The copy rebinds session_id to the fork and lets the rowid
  // (messages.id) auto-assign — explicit rowids would collide with the
  // source's.
  const messageInsertCols = messageCols.filter((col) => col !== "id");
  const messageSelectRefs = messageInsertCols.map((col) =>
    col === "session_id" ? "?" : col,
  );

  dbWritable.exec("BEGIN IMMEDIATE");
  try {
    const inserted = dbWritable
      .prepare(
        `INSERT INTO sessions (${insertCols.join(", ")}) ` +
          `SELECT ${selectRefs.join(", ")} FROM sessions WHERE id = ?`,
      )
      .run(
        forkId,
        forkSessionName(name),
        ...(hasParentColumn ? [sourceId] : []),
        sourceId,
      );
    if (inserted.changes !== 1) {
      dbWritable.exec("ROLLBACK");
      return fail(404, `No session ${sourceId}.`);
    }
    if (messageInsertCols.length > 0) {
      const where =
        boundary === undefined
          ? "session_id = ?"
          : "session_id = ? AND (created_timestamp, id) <= (?, ?)";
      dbWritable
        .prepare(
          `INSERT INTO messages (${messageInsertCols.join(", ")}) ` +
            `SELECT ${messageSelectRefs.join(", ")} FROM messages ` +
            `WHERE ${where} ORDER BY created_timestamp ASC, id ASC`,
        )
        .run(
          forkId,
          sourceId,
          ...(boundary === undefined
            ? []
            : [boundary.createdTimestamp, boundary.id]),
        );
    }
    dbWritable.exec("COMMIT");
  } catch (err) {
    dbWritable.exec("ROLLBACK");
    const detail = err instanceof Error ? err.message : String(err);
    return fail(500, `Could not copy the session: ${detail}`);
  }

  const row = getSession(dbWritable, forkId);
  return row === undefined
    ? fail(500, "The forked session could not be read back.")
    : { ok: true, row };
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
  deleteSessions: (ids) => deleteSessions(dbWritable, ids),
  forkSession: (id, cutoff) => forkSession(dbWritable, id, cutoff),
  firstPromptSessionName: (ids) => firstPromptSessionName(db, ids),
  prCandidateIds: (ids) => prCandidateIds(db, ids),
});

export {
  createSessionStore,
  getSession,
  openDb,
  openServeDbs,
  resolveDbPath,
  sessionIdsInDir,
};
