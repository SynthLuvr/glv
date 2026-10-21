import { DatabaseSync } from "node:sqlite";
import { openGlvDb, resolveDataPath } from "./db-path.js";

// Viewer-owned sidecar recording why a session's last run stopped early,
// keyed by the (namespaced) session id. Two shapes land here: a provider
// refusal — a usage limit with its reset time, a network outage —
// announced only on the agent's stdout, never in the transcript the
// viewer renders; and a run-terminal error — crash exit code, signal
// death, startup-watchdog kill — whose message carries the exit verdict
// and a stderr tail. The in-memory run handle is evicted seconds after
// the process exits; this table is what makes either explanation survive
// a reload or a server restart. A clean settle or manual stop clears the
// row, so the notice always describes the *last* run.

const STOP_NOTICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS stop_notices (
  session_id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

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

// glv owns the whole file and always creates the schema on open.
const openStopNoticesDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
  db.exec(STOP_NOTICES_SCHEMA);
  return db;
};

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

// Every read failure (missing row, missing table, malformed value) reads
// as undefined, so a hand-edited database degrades to no notice.
const readStopNotice = (
  db: DatabaseSync,
  sessionId: string,
): string | undefined => {
  try {
    const row = db
      .prepare("SELECT message FROM stop_notices WHERE session_id = ?")
      .get(sessionId);
    if (typeof row !== "object" || row === null) return undefined;
    const { message } = row;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
};

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
