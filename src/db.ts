import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";

const SessionRow = type({
  id: "string",
  name: "string",
  description: "string",
  session_type: "string",
  working_dir: "string",
  created_at: "string",
  updated_at: "string",
  total_tokens: "number | null",
  provider_name: "string | null",
  archived_at: "string | null",
});

type SessionRow = typeof SessionRow.infer;

const MessageRow = type({
  message_id: "string | null",
  session_id: "string",
  role: "string",
  content_json: "string",
  created_timestamp: "number",
  timestamp: "string",
});

type MessageRow = typeof MessageRow.infer;

type SessionFilter = {
  type: string;
  limit: number;
  includeArchived: boolean;
};

const defaultDbPath = (): string =>
  join(homedir(), ".local", "share", "goose", "sessions", "sessions.db");

const resolveDbPath = (override?: string): string =>
  override ?? process.env.GOOSE_SESSIONS_DB ?? defaultDbPath();

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

const sessionColumns =
  "id, name, description, session_type, working_dir, created_at, " +
  "updated_at, total_tokens, provider_name, archived_at";

const validateRows = <T>(
  schema: (data: unknown) => T | type.errors,
  rows: unknown[],
): T[] =>
  rows
    .map((row) => schema(row))
    .filter((r): r is T => !(r instanceof type.errors));

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
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const sql = `SELECT ${sessionColumns} FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`;
  params.push(filter.limit);
  return validateRows(SessionRow, db.prepare(sql).all(...params));
};

const getSession = (db: DatabaseSync, id: string): SessionRow | undefined => {
  const row = db
    .prepare(`SELECT ${sessionColumns} FROM sessions WHERE id = ?`)
    .get(id);
  if (row === undefined) return undefined;
  const result = SessionRow(row);
  if (result instanceof type.errors) return undefined;
  return result;
};

const listMessages = (db: DatabaseSync, sessionId: string): MessageRow[] => {
  const sql =
    "SELECT message_id, session_id, role, content_json, created_timestamp, " +
    "timestamp FROM messages WHERE session_id = ? ORDER BY created_timestamp ASC";
  return validateRows(MessageRow, db.prepare(sql).all(sessionId));
};

// Lets the new-session poll distinguish a freshly created session from
// pre-existing ones in the same working dir.
const sessionIdsInDir = (db: DatabaseSync, workingDir: string): string[] => {
  const rows = db
    .prepare("SELECT id FROM sessions WHERE working_dir = ?")
    .all(workingDir) as { id: unknown }[];
  return rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");
};

const listWorkingDirs = (db: DatabaseSync): string[] => {
  const rows = db
    .prepare("SELECT DISTINCT working_dir FROM sessions ORDER BY working_dir")
    .all() as { working_dir: unknown }[];
  return rows
    .map((row) => row.working_dir)
    .filter((dir): dir is string => typeof dir === "string");
};

const archiveSessions = (db: DatabaseSync, ids: string[]): void => {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  const sql =
    "UPDATE sessions SET archived_at = CURRENT_TIMESTAMP " +
    `WHERE id IN (${placeholders}) AND archived_at IS NULL`;
  db.prepare(sql).run(...ids);
};

export type { MessageRow, SessionFilter, SessionRow };
export {
  archiveSessions,
  getSession,
  listMessages,
  listSessions,
  listWorkingDirs,
  openDb,
  resolveDbPath,
  sessionIdsInDir,
};
