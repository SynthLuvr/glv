import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { defineTable, placeholders } from "./query";

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

type SessionFilter = {
  type: string;
  limit: number;
  includeArchived: boolean;
};

const sessions = defineTable({
  table: "sessions",
  columns: Object.keys(sessionShape),
  schema: SessionRow,
});

const messages = defineTable({
  table: "messages",
  columns: Object.keys(messageShape),
  schema: MessageRow,
});

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
  const where = clauses.length === 0 ? undefined : clauses.join(" AND ");
  return sessions.all(db, {
    where,
    params,
    orderBy: "updated_at DESC",
    limit: filter.limit,
  });
};

const getSession = (db: DatabaseSync, id: string): SessionRow | undefined =>
  sessions.one(db, { where: "id = ?", params: [id] });

const listMessages = (db: DatabaseSync, sessionId: string): MessageRow[] =>
  messages.all(db, {
    where: "session_id = ?",
    params: [sessionId],
    orderBy: "created_timestamp ASC",
  });

// Lets the new-session poll distinguish a freshly created session from
// pre-existing ones in the same working dir. Projects only `id` and validates
// leniently so a half-written row is still recognised.
const sessionIdsInDir = (db: DatabaseSync, workingDir: string): string[] => {
  const idOnly = defineTable({
    table: "sessions",
    columns: ["id"],
    schema: type({ id: "string" }),
  });
  return idOnly
    .all(db, { where: "working_dir = ?", params: [workingDir] })
    .map((row) => row.id);
};

const archiveSessions = (db: DatabaseSync, ids: string[]): void => {
  if (ids.length === 0) return;
  sessions.update(db, {
    set: "archived_at = CURRENT_TIMESTAMP",
    where: `id IN (${placeholders(ids.length)}) AND archived_at IS NULL`,
    params: ids,
  });
};

// A blank name clears the user-set flag.
const renameSession = (db: DatabaseSync, id: string, rawName: string): void => {
  const name = rawName.trim();
  sessions.update(db, {
    set: "name = ?, user_set_name = ?",
    where: "id = ?",
    params: [name, name === "" ? 0 : 1, id],
  });
};

export type { MessageRow, SessionFilter, SessionRow };
export {
  archiveSessions,
  getSession,
  listMessages,
  listSessions,
  openDb,
  renameSession,
  resolveDbPath,
  sessionIdsInDir,
};
