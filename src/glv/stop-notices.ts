import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb, resolveDataPath } from "./db-path.js";

// Viewer-owned sidecar recording why a session's last run stopped early,
// keyed by the (namespaced) session id. The agent's own announcement of a
// provider refusal — a usage limit with its reset time, a network outage —
// lives only on its stdout stream and in its logs: it never reaches the
// transcript the viewer renders, and the in-memory run handle is evicted
// seconds after the process exits. This table is what makes the notice
// survive a reload or a server restart, exactly like the rename/archive
// meta sidecar and the cron-session tags.

const STOP_NOTICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS stop_notices (
  session_id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const Row = type({ session_id: "string", message: "string" });

type Row = typeof Row.infer;

const validate = (row: unknown): Row | undefined => {
  const result = Row(row);
  return result instanceof type.errors ? undefined : result;
};

const resolveStopNoticesDbPath = (
  dataDirName: string,
  override?: string,
): string =>
  resolveDataPath(
    override,
    "GLV_STOP_NOTICES_DB",
    dataDirName,
    "stop-notices.db",
  );

// Writable by design: glv owns the whole file and always creates the
// schema on open, exactly like the meta sidecar.
const openStopNoticesDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
  db.exec(STOP_NOTICES_SCHEMA);
  return db;
};

// Upsert: a fresh refusal for the same session replaces the old notice.
const recordStopNotice = (
  db: DatabaseSync,
  sessionId: string,
  message: string,
): void => {
  db.prepare(
    "INSERT INTO stop_notices (session_id, message) VALUES (?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET " +
      "message = excluded.message, recorded_at = datetime('now')",
  ).run(sessionId, message);
};

const readStopNotice = (db: DatabaseSync, sessionId: string): Row | undefined =>
  validate(
    db
      .prepare(
        "SELECT session_id, message FROM stop_notices WHERE session_id = ?",
      )
      .get(sessionId),
  );

// The notice clears when the session continues: a run that starts (or
// finishes cleanly) resolves the outage it described.
const clearStopNotice = (db: DatabaseSync, sessionId: string): void => {
  db.prepare("DELETE FROM stop_notices WHERE session_id = ?").run(sessionId);
};

export {
  clearStopNotice,
  openStopNoticesDb,
  readStopNotice,
  recordStopNotice,
  resolveStopNoticesDbPath,
};
