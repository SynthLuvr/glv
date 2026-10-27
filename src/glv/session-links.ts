import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb } from "./db-path.js";
import { placeholders } from "./query.js";

// Viewer-owned sidecar linking worker sessions to the orchestrator session
// that launched them (#385): the parent link is the only record of who
// launched whom, so the sidebar can nest workers under their orchestrator
// and loops can query their members (?parent_session=) without leaning on
// working-directory or name conventions, which break the moment a human
// works in the same place. Like cron_sessions (the same question for
// scheduled runs), the table lives in the cron database and is keyed by
// the namespaced session id; the agent's own stores stay untouched.

// Exported so openCronDb can create it beside the cron tables through one
// handle.
const SESSION_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_parents (
  session_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL
);
`;

const Row = type({ session_id: "string", parent_session_id: "string" });

type Row = typeof Row.infer;

const validate = (row: unknown): Row | undefined => {
  const result = Row(row);
  return result instanceof type.errors ? undefined : result;
};

const openSessionLinksDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
  db.exec(SESSION_LINKS_SCHEMA);
  return db;
};

// Records (or re-points) a session's orchestrator. Idempotent upsert, so a
// retried create after a crash-retry loop simply overwrites.
const tagParentSession = (
  db: DatabaseSync,
  sessionId: string,
  parentSessionId: string,
): void => {
  db.prepare(
    "INSERT INTO session_parents (session_id, parent_session_id) " +
      "VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE " +
      "SET parent_session_id = excluded.parent_session_id",
  ).run(sessionId, parentSessionId);
};

// The parent recorded for one session, if any.
const parentSessionFor = (
  db: DatabaseSync,
  sessionId: string,
): string | undefined =>
  validate(
    db
      .prepare(
        "SELECT session_id, parent_session_id FROM session_parents " +
          "WHERE session_id = ?",
      )
      .get(sessionId),
  )?.parent_session_id;

// The parent map for a whole listing — one query, like jobNamesFor.
const parentSessionsFor = (
  db: DatabaseSync,
  sessionIds: readonly string[],
): Map<string, string> => {
  const result = new Map<string, string>();
  if (sessionIds.length === 0) return result;
  const rows: unknown[] = db
    .prepare(
      `SELECT session_id, parent_session_id FROM session_parents ` +
        `WHERE session_id IN (${placeholders(sessionIds.length)})`,
    )
    .all(...sessionIds);
  for (const row of rows) {
    const valid = validate(row);
    if (valid !== undefined)
      result.set(valid.session_id, valid.parent_session_id);
  }
  return result;
};

// Every session launched by one orchestrator — the ?parent_session= filter's
// answer set, newest-first like the store's own listing order. The rows
// carry only the id, so a single-column shape validates them.
const ChildIdRow = type({ session_id: "string" });

const childSessionIds = (db: DatabaseSync, parentSessionId: string): string[] =>
  db
    .prepare(
      "SELECT session_id FROM session_parents " +
        "WHERE parent_session_id = ? ORDER BY rowid DESC",
    )
    .all(parentSessionId)
    .map((row) => {
      const result = ChildIdRow(row);
      return result instanceof type.errors ? undefined : result.session_id;
    })
    .filter((id): id is string => id !== undefined);

// Deleting a session drops every link it participates in: its own parent
// row, and the rows naming it as the parent of now-orphaned workers (they
// nest under nothing and list flat again).
const forgetParentLinks = (db: DatabaseSync, sessionId: string): void => {
  db.prepare(
    "DELETE FROM session_parents WHERE session_id = ? OR parent_session_id = ?",
  ).run(sessionId, sessionId);
};

export {
  childSessionIds,
  forgetParentLinks,
  openSessionLinksDb,
  parentSessionFor,
  parentSessionsFor,
  SESSION_LINKS_SCHEMA,
  tagParentSession,
};
