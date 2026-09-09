import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { CRON_SESSIONS_SCHEMA } from "./cron-sessions.js";
import { openGlvDb } from "./db-path.js";
import { validateAll } from "./query.js";
import { positiveEnvNumber } from "./util.js";

// The cron job store. Jobs live in the cron database (cron.db) beside
// the session-tag sidecar. The web UI mutates rows here, the scheduler
// reads them, and a poll watches for external writers.

// The shape every job carries: name is the cron_jobs primary key, so
// every stored job is named.
const CronJob = type({
  name: "string",
  schedule: "string>0",
  prompt: "string>0",
  workingDir: "string>0",
  "timezone?": "string",
  "enabled?": "boolean",
  // A model pin for the sessions this job starts: both keys together, or
  // neither for the agent's own default.
  "modelProvider?": "string>0",
  "model?": "string>0",
});

type CronJobConfig = typeof CronJob.infer;

// A job as read back from a row, `enabled` defaulted on.
type CronJobRecord = CronJobConfig & {
  readonly enabled: boolean;
};

// Shared with the test harness, whose row helpers may open a database
// before serve's first boot has created the table.
const CRON_JOBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  name           TEXT PRIMARY KEY,
  schedule       TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  working_dir    TEXT NOT NULL,
  timezone       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  model_provider TEXT,
  model          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// One database file, two tables: the schedule itself and the
// job-started-session tags the sidebar badges read. Opening creates
// both so serve's single handle serves the scheduler, the routes, and
// the badges — exactly like every other glv-owned open.
const openCronDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
  db.exec(CRON_JOBS_SCHEMA);
  db.exec(CRON_SESSIONS_SCHEMA);
  return db;
};

// node:sqlite widens everything it can; the row shape pins what the
// table actually stores so a drifted or tampered row is dropped rather
// than trusted (the scheduler still validates what survives).
const JobRow = type({
  name: "string",
  schedule: "string",
  prompt: "string",
  working_dir: "string",
  timezone: "string | null",
  enabled: "number",
  model_provider: "string | null",
  model: "string | null",
});

type JobRow = typeof JobRow.infer;

const JOB_COLS =
  "name, schedule, prompt, working_dir, timezone, enabled, " +
  "model_provider, model";

const mapRow = (row: JobRow): CronJobRecord => ({
  name: row.name,
  schedule: row.schedule,
  prompt: row.prompt,
  workingDir: row.working_dir,
  ...(row.timezone === null ? {} : { timezone: row.timezone }),
  enabled: row.enabled !== 0,
  ...(row.model_provider === null || row.model === null
    ? {}
    : { modelProvider: row.model_provider, model: row.model }),
});

// Insertion order, like the config array had: rowid survives renames,
// so a renamed job keeps its place in the section.
const listCronJobs = (db: DatabaseSync): CronJobRecord[] =>
  validateAll(
    JobRow,
    db.prepare(`SELECT ${JOB_COLS} FROM cron_jobs ORDER BY rowid`).all(),
  ).map(mapRow);

// The write shape every mutation shares: values in JOB_COLS order —
// full row (the UI never patches single columns), optionals nulled,
// enabled defaulted on.
const jobParams = (job: CronJobConfig): (string | number | null)[] => [
  job.name,
  job.schedule,
  job.prompt,
  job.workingDir,
  job.timezone ?? null,
  job.enabled === false ? 0 : 1,
  job.modelProvider ?? null,
  job.model ?? null,
];

const INSERT_SQL = `INSERT INTO cron_jobs (${JOB_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

// Appends a job. The caller owns duplicate-name shaping of the
// user-facing error; a colliding insert still fails loudly here (the
// table's primary key is the backstop).
const insertCronJob = (db: DatabaseSync, job: CronJobConfig): void => {
  db.prepare(INSERT_SQL).run(...jobParams(job));
};

// Replaces a job's fields, rename included (name is the key, so the
// row is re-keyed when the name changed). False when nothing matched
// the current name.
const updateCronJob = (
  db: DatabaseSync,
  currentName: string,
  job: CronJobConfig,
): boolean =>
  db
    .prepare(
      `UPDATE cron_jobs
         SET name = ?, schedule = ?, prompt = ?, working_dir = ?,
             timezone = ?, enabled = ?, model_provider = ?, model = ?,
             updated_at = datetime('now')
         WHERE name = ?`,
    )
    .run(...jobParams(job), currentName).changes > 0;

// Pause/resume without touching anything else the form never exposes.
const setCronJobEnabled = (
  db: DatabaseSync,
  name: string,
  enabled: boolean,
): boolean =>
  db
    .prepare(
      `UPDATE cron_jobs
         SET enabled = ?, updated_at = datetime('now')
         WHERE name = ?`,
    )
    .run(enabled ? 1 : 0, name).changes > 0;

// Removes a job by name; false when nothing matched. One-shots retire
// through here once their moment passes.
const deleteCronJob = (db: DatabaseSync, name: string): boolean =>
  db.prepare("DELETE FROM cron_jobs WHERE name = ?").run(name).changes > 0;

// The scheduler's change signal for the database. There is no
// fs.watch for SQLite, so a poll re-reads the table (the reload itself
// no-ops when the resolved set is unchanged); UI mutations nudge the
// reload directly, so the poll's interval only bounds external writers
// (a future cron CLI, direct sqlite3 use). GLV_CRON_DB_POLL_MS
// overrides the interval so tests can bound the reload latency.
const DEFAULT_DB_POLL_MS = 5_000;

const watchCronJobs = (onChange: () => void): { readonly stop: () => void } => {
  const poll = setInterval(
    () => onChange(),
    positiveEnvNumber("GLV_CRON_DB_POLL_MS", DEFAULT_DB_POLL_MS),
  );
  return { stop: () => clearInterval(poll) };
};

export type { CronJobConfig };
export {
  CRON_JOBS_SCHEMA,
  deleteCronJob,
  insertCronJob,
  listCronJobs,
  openCronDb,
  setCronJobEnabled,
  updateCronJob,
  watchCronJobs,
};
