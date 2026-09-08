import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { readRawConfig, writeConfig } from "./config.js";
import { CRON_SESSIONS_SCHEMA } from "./cron-sessions.js";
import { openGlvDb } from "./db-path.js";
import { transaction, validateAll } from "./query.js";
import { resolvedCronName } from "./schedule.js";
import { positiveEnvNumber } from "./util.js";

// The cron job store. Jobs used to live in the config file's cronJobs
// array; they now live in the cron database (cron.db) beside the
// session-tag sidecar, with the config file's entries migrated in at
// boot (migrateCronJobsFromConfig). The web UI mutates rows here, the
// scheduler reads them, and a poll watches for external writers.

// The job shape the config file used to spell (and the migration still
// accepts): a name is optional there because hand-edited entries could
// omit it, and the array position named them (cron-1, cron-2, …).
const CronJob = type({
  "name?": "string",
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

// A stored row: the same shape, but always named — name is the table's
// primary key, so the positional cron-<n> fallback is applied once, at
// migration.
type CronJobRecord = CronJobConfig & {
  readonly name: string;
  readonly enabled: boolean;
};

// Writes take the record minus the bookkeeping columns; created_at /
// updated_at are owned by the table.
type CronJobWrite = Omit<CronJobRecord, "enabled"> & {
  readonly enabled?: boolean;
};

const SCHEMA = `
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
  db.exec(SCHEMA);
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

// The write shape every mutation shares: full row values (the UI never
// patches single columns), enabled defaulted on.
const jobValues = (
  job: CronJobWrite,
): {
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly workingDir: string;
  readonly timezone: string | null;
  readonly enabled: number;
  readonly modelProvider: string | null;
  readonly model: string | null;
} => ({
  name: job.name,
  schedule: job.schedule,
  prompt: job.prompt,
  workingDir: job.workingDir,
  timezone: job.timezone ?? null,
  enabled: job.enabled === false ? 0 : 1,
  modelProvider: job.modelProvider ?? null,
  model: job.model ?? null,
});

const INSERT_SQL =
  "INSERT INTO cron_jobs " +
  "(name, schedule, prompt, working_dir, timezone, enabled, " +
  "model_provider, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(name) DO UPDATE SET " +
  "schedule = excluded.schedule, prompt = excluded.prompt, " +
  "working_dir = excluded.working_dir, timezone = excluded.timezone, " +
  "enabled = excluded.enabled, model_provider = excluded.model_provider, " +
  "model = excluded.model, updated_at = datetime('now')";

const upsert = (db: DatabaseSync, job: CronJobWrite): void => {
  const v = jobValues(job);
  db.prepare(INSERT_SQL).run(
    v.name,
    v.schedule,
    v.prompt,
    v.workingDir,
    v.timezone,
    v.enabled,
    v.modelProvider,
    v.model,
  );
};

// Appends a job. The caller owns duplicate-name shaping of the
// user-facing error; a colliding insert still fails loudly here (the
// table's primary key is the backstop).
const insertCronJob = (db: DatabaseSync, job: CronJobWrite): void => {
  const v = jobValues(job);
  db.prepare(
    "INSERT INTO cron_jobs " +
      "(name, schedule, prompt, working_dir, timezone, enabled, " +
      "model_provider, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    v.name,
    v.schedule,
    v.prompt,
    v.workingDir,
    v.timezone,
    v.enabled,
    v.modelProvider,
    v.model,
  );
};

// Replaces a job's fields, rename included (name is the key, so the
// row is re-keyed when the name changed). False when nothing matched
// the current name.
const updateCronJob = (
  db: DatabaseSync,
  currentName: string,
  job: CronJobWrite,
): boolean => {
  const v = jobValues(job);
  const result = db
    .prepare(
      `UPDATE cron_jobs
         SET name = ?, schedule = ?, prompt = ?, working_dir = ?,
             timezone = ?, enabled = ?, model_provider = ?, model = ?,
             updated_at = datetime('now')
         WHERE name = ?`,
    )
    .run(
      v.name,
      v.schedule,
      v.prompt,
      v.workingDir,
      v.timezone,
      v.enabled,
      v.modelProvider,
      v.model,
      currentName,
    );
  return result.changes > 0;
};

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

// The config-file shape as it used to validate, kept only so the
// migration rejects a malformed cronJobs value with the same message
// serve always did.
const CronJobsConfig = type({ "cronJobs?": type([CronJob, "[]"]) });

type MigrationDeps = {
  /**
   * Validates the whole merged set the way the scheduler will (unique
   * names, parseable schedules, …) — thrown errors refuse serve before
   * anything is written, leaving the file hand-fixable.
   */
  readonly validateSet: (jobs: readonly CronJobConfig[]) => void;
};

// Imports the config file's cronJobs array into the database and strips
// the key from the file — the one-time bridge from the old store. Runs
// at every serve boot; a file without the key (the common case after
// the first run) is a no-op. File entries win on a name collision, so
// re-adding jobs to the file re-imports them once, never duplicated.
const migrateCronJobsFromConfig = (
  dataDirName: string,
  db: DatabaseSync,
  deps: MigrationDeps,
): void => {
  const raw = readRawConfig(dataDirName);
  if (raw.cronJobs === undefined) return;
  const parsed = CronJobsConfig(raw);
  if (parsed instanceof type.errors)
    throw new Error(`invalid glv config: ${parsed.summary}`);
  const fromFile = parsed.cronJobs ?? [];

  // The file's own entries are validated before anything is merged or
  // written: a duplicate name inside the file (invisible after the
  // name-keyed merge below) refuses serve here, with the file left
  // untouched, exactly as the config-reader used to refuse it.
  deps.validateSet(fromFile);

  // File entries win on a name collision with a stored row, so
  // re-adding jobs to the file re-imports them once, never duplicated.
  const merged = new Map(
    listCronJobs(db).map((job) => [job.name, job] as const),
  );
  fromFile.forEach((job, index) => {
    merged.set(resolvedCronName(job, index), {
      ...job,
      name: resolvedCronName(job, index),
      enabled: job.enabled !== false,
    });
  });
  const jobs = [...merged.values()];
  deps.validateSet(jobs);

  transaction(db, () => {
    for (const job of jobs) upsert(db, job);
  });
  delete raw.cronJobs;
  writeConfig(dataDirName, raw);
  if (fromFile.length > 0)
    console.log(
      `cron: migrated ${fromFile.length} job(s) from the config file ` +
        "into the cron database",
    );
};

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

export type { CronJobConfig, CronJobRecord, CronJobWrite };
export {
  deleteCronJob,
  insertCronJob,
  listCronJobs,
  migrateCronJobsFromConfig,
  openCronDb,
  setCronJobEnabled,
  updateCronJob,
  watchCronJobs,
};
