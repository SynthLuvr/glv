import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { resolveDataPath } from "./db-path";
import { placeholders, validate, validateAll } from "./query";

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

const SessionRow = type(sessionShape);

type SessionRow = typeof SessionRow.infer;

const SESSION_COLS = Object.keys(sessionShape).join(", ");

const messageShape = {
  message_id: "string | null",
  session_id: "string",
  role: "string",
  content_json: "string",
  created_timestamp: "number",
  timestamp: "string",
} as const;

const MessageRow = type(messageShape);

type MessageRow = typeof MessageRow.infer;

const MESSAGE_COLS = Object.keys(messageShape).join(", ");

type SessionFilter = {
  type: string;
  limit: number;
  includeArchived: boolean;
};

// goose may store its DB elsewhere on Windows; override with
// GOOSE_SESSIONS_DB or --db when the default doesn't match.
const resolveDbPath = (override?: string): string =>
  resolveDataPath(
    override,
    "GOOSE_SESSIONS_DB",
    "goose",
    "sessions",
    "sessions.db",
  );

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
  return validateAll(SessionRow, db.prepare(parts.join(" ")).all(...params));
};

const getSession = (db: DatabaseSync, id: string): SessionRow | undefined =>
  validate(
    SessionRow,
    db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(id),
  );

const listMessages = (db: DatabaseSync, sessionId: string): MessageRow[] =>
  validateAll(
    MessageRow,
    db
      .prepare(
        `SELECT ${MESSAGE_COLS} FROM messages
           WHERE session_id = ?
           ORDER BY created_timestamp ASC`,
      )
      .all(sessionId),
  );

const IdRow = type({ id: "string" });

// Lets the new-session poll distinguish a freshly created session from
// pre-existing ones in the same working dir. Selects only `id` with a lenient
// schema so a half-written row still matches.
const sessionIdsInDir = (db: DatabaseSync, workingDir: string): string[] =>
  validateAll(
    IdRow,
    db.prepare("SELECT id FROM sessions WHERE working_dir = ?").all(workingDir),
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
// whose first user prompt came earliest.  `undefined` when none of the
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

export type { MessageRow, SessionFilter, SessionRow };
export {
  archiveSessions,
  firstPromptSessionName,
  getSession,
  listMessages,
  listSessions,
  openDb,
  prCandidateIds,
  renameSession,
  resolveDbPath,
  sessionIdsInDir,
};
