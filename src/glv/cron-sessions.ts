import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb, resolveDataPath } from "./db-path.js";

// Viewer-owned sidecar remembering which scheduled job started which
// session, so the sidebar and transcript header can badge job-started
// sessions. The agent's own stores stay untouched; this table is glv's,
// like the rename/archive meta sidecar.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_sessions (
  session_id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  fired_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const Row = type({ session_id: "string", job_name: "string" });

type Row = typeof Row.infer;

const validate = (row: unknown): Row | undefined => {
  const result = Row(row);
  return result instanceof type.errors ? undefined : result;
};

const resolveCronDbPath = (dataDirName: string, override?: string): string =>
  resolveDataPath(override, "GLV_CRON_DB", dataDirName, "cron.db");

// Writable by design: glv owns the whole file and always creates the
// schema on open, exactly like the meta sidecar.
const openCronSessionsDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
  db.exec(SCHEMA);
  return db;
};

const tagCronSession = (
  db: DatabaseSync,
  sessionId: string,
  jobName: string,
): void => {
  db.prepare(
    "INSERT INTO cron_sessions (session_id, job_name) VALUES (?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET job_name = excluded.job_name",
  ).run(sessionId, jobName);
};

const jobNameFor = (db: DatabaseSync, sessionId: string): string | undefined =>
  validate(
    db
      .prepare(
        "SELECT session_id, job_name FROM cron_sessions " +
          "WHERE session_id = ?",
      )
      .get(sessionId),
  )?.job_name;

const jobNamesFor = (
  db: DatabaseSync,
  sessionIds: readonly string[],
): Map<string, string> => {
  const result = new Map<string, string>();
  if (sessionIds.length === 0) return result;
  const placeholders = sessionIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT session_id, job_name FROM cron_sessions ` +
        `WHERE session_id IN (${placeholders})`,
    )
    .all(...sessionIds) as unknown[];
  for (const row of rows) {
    const valid = validate(row);
    if (valid !== undefined) result.set(valid.session_id, valid.job_name);
  }
  return result;
};

// Permanent session removal drops the job tag with it, so no trace of the
// session survives in the sidecar.
const untagCronSession = (db: DatabaseSync, sessionId: string): void => {
  db.prepare("DELETE FROM cron_sessions WHERE session_id = ?").run(sessionId);
};

export {
  jobNameFor,
  jobNamesFor,
  openCronSessionsDb,
  resolveCronDbPath,
  tagCronSession,
  untagCronSession,
};
