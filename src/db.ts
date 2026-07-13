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

const openDb = (dbPath: string): DatabaseSync => {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not open goose sessions database at ${dbPath}: ${detail}`,
    );
  }
};

const sessionColumns = [
  "id",
  "name",
  "description",
  "session_type",
  "working_dir",
  "created_at",
  "updated_at",
  "total_tokens",
  "provider_name",
  "archived_at",
].join(", ");

const keepSession = (row: SessionRow | type.errors): row is SessionRow =>
  !(row instanceof type.errors);

const keepMessage = (row: MessageRow | type.errors): row is MessageRow =>
  !(row instanceof type.errors);

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
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => SessionRow(row))
    .filter(keepSession);
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
  const sql = [
    "SELECT message_id, session_id, role, content_json,",
    "created_timestamp, timestamp FROM messages",
    "WHERE session_id = ? ORDER BY created_timestamp ASC",
  ].join(" ");
  return db
    .prepare(sql)
    .all(sessionId)
    .map((row) => MessageRow(row))
    .filter(keepMessage);
};

export type { MessageRow, SessionFilter, SessionRow };
export { getSession, listMessages, listSessions, openDb, resolveDbPath };
