import { type DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { CRON_SESSIONS_SCHEMA } from "./cron-sessions.js";
import { openGlvDb } from "./db-path.js";
import { validateAll } from "./query.js";
import { MAX_CRON_STEPS } from "./schedule.js";
import { SESSION_LINKS_SCHEMA } from "./session-links.js";
import { positiveEnvNumber } from "./util.js";

// The cron job store: jobs live in the cron database (cron.db) beside
// the session-tag sidecar. The web UI mutates rows here, the
// scheduler reads them, and a poll watches for external writers.

// A job as every reader and writer spells it. name is the table's
// primary key, so every job is always named; enabled is the column's
// default-on flag, so writes may omit it.
type CronJobConfig = {
  name: string;
  schedule: string;
  // The schedule exactly as last typed, kept when `schedule` holds its
  // translated cron so the edit form prefills the human-readable text
  // the user wrote; absent when the schedule column is itself what was
  // typed.
  scheduleInput?: string;
  prompt: string;
  workingDir: string;
  timezone?: string;
  enabled?: boolean;
  // Which agent's launcher fires this job ("goose", "claude"). Required
  // on every write; reads fall back to the store's default for rows
  // written before the column existed.
  agent?: string;
  // A model pin for the sessions this job starts: both keys together, or
  // neither for the agent's own default.
  modelProvider?: string;
  model?: string;
  // Follow-on prompts: each starts a new session after the first
  // prompt's finishes, strictly in order. Absent means a plain
  // single-prompt job.
  followUps?: readonly string[];
  // The most recent occurrence this job served, ISO UTC (read-only for
  // every writer here): inserts seed it to now, and only the
  // scheduler's fire path updates it (recordCronFire) — the missed-run
  // catch-up compares occurrences against it.
  lastFiredAt?: string;
};

// A stored row: the same shape, but always enabled — the column
// defaults on, so a read never lacks it.
type CronJobRecord = CronJobConfig & {
  readonly enabled: boolean;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  name           TEXT PRIMARY KEY,
  schedule       TEXT NOT NULL,
  schedule_input TEXT,
  prompt         TEXT NOT NULL,
  working_dir    TEXT NOT NULL,
  timezone       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  agent          TEXT,
  model_provider TEXT,
  model          TEXT,
  follow_ups     TEXT,
  last_fired_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// One database file, two tables: the schedule itself and the
// job-started-session tags the sidebar badges read. Opening creates
// both so serve's single handle serves the scheduler, the routes, and
// the badges — exactly like every other glv-owned open. Rows keep a
// NULL agent until the server (which knows its default) backfills them
// on its own open, so external writers and test seeds never see an
// agent minted for them.
const openCronDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
  db.exec(SCHEMA);
  db.exec(CRON_SESSIONS_SCHEMA);
  db.exec(SESSION_LINKS_SCHEMA);
  return db;
};

// The server-open backfill: rows written before the agent column
// existed (or hand-edited back to NULL) belong to the server's default
// agent. Idempotent.
const backfillCronAgents = (db: DatabaseSync, defaultAgent: string): void => {
  db.prepare("UPDATE cron_jobs SET agent = ? WHERE agent IS NULL").run(
    defaultAgent,
  );
};

// node:sqlite widens everything it can; the row shape pins what the
// table actually stores so a drifted or tampered row is dropped rather
// than trusted (the scheduler still validates what survives).
const JobRow = type({
  name: "string",
  schedule: "string",
  schedule_input: "string | null",
  prompt: "string",
  working_dir: "string",
  timezone: "string | null",
  enabled: "number",
  agent: "string | null",
  model_provider: "string | null",
  model: "string | null",
  follow_ups: "string | null",
  last_fired_at: "string | null",
});

type JobRow = typeof JobRow.infer;

const JOB_COLS =
  "name, schedule, schedule_input, prompt, working_dir, timezone, " +
  "enabled, agent, model_provider, model, follow_ups, last_fired_at";

// follow_ups holds a JSON array of follow-on prompts, read as strictly
// as the rest of the row: anything but an array of strings — trimmed,
// blank-free, inside the step cap — is a read error naming the row, so
// a hand-edit surfaces (the scheduler keeps the running schedule, the
// UI shows the error) instead of silently truncating a pipeline.
const FollowUpsValue = type("string[]");

const parseFollowUps = (name: string, raw: string): string[] => {
  const invalid = (why: string): Error =>
    new Error(`cron job "${name}" has an invalid follow_ups value (${why})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("not valid JSON");
  }
  const checked = FollowUpsValue(parsed);
  if (checked instanceof type.errors)
    throw invalid("not a JSON array of strings");
  const steps = checked
    .map((step) => step.trim())
    .filter((step) => step !== "");
  if (steps.length > MAX_CRON_STEPS - 1)
    throw invalid(
      `more than ${MAX_CRON_STEPS - 1} follow-on steps ` +
        `(the cap is ${MAX_CRON_STEPS} steps in total)`,
    );
  return steps;
};

const mapRow = (row: JobRow, defaultAgent: string): CronJobRecord => ({
  name: row.name,
  schedule: row.schedule,
  ...(row.schedule_input === null ? {} : { scheduleInput: row.schedule_input }),
  prompt: row.prompt,
  workingDir: row.working_dir,
  ...(row.timezone === null ? {} : { timezone: row.timezone }),
  enabled: row.enabled !== 0,
  agent: row.agent ?? defaultAgent,
  ...(row.model_provider === null || row.model === null
    ? {}
    : { modelProvider: row.model_provider, model: row.model }),
  ...(row.follow_ups === null
    ? {}
    : { followUps: parseFollowUps(row.name, row.follow_ups) }),
  ...(row.last_fired_at === null ? {} : { lastFiredAt: row.last_fired_at }),
});

// Insertion order: rowid survives renames, so a renamed job keeps its
// place in the section.
const listCronJobs = (
  db: DatabaseSync,
  defaultAgent: string,
): CronJobRecord[] =>
  validateAll(
    JobRow,
    db.prepare(`SELECT ${JOB_COLS} FROM cron_jobs ORDER BY rowid`).all(),
  ).map((row) => mapRow(row, defaultAgent));

// The write shape every mutation shares: values in JOB_COLS order —
// full row (the UI never patches single columns), optionals nulled,
// enabled defaulted on — with last_fired_at supplied by the caller
// (the insert seeds it; updates never write it).
const jobParams = (job: CronJobConfig): (string | number | null)[] => [
  job.name,
  job.schedule,
  job.scheduleInput ?? null,
  job.prompt,
  job.workingDir,
  job.timezone ?? null,
  job.enabled === false ? 0 : 1,
  job.agent ?? null,
  job.modelProvider ?? null,
  job.model ?? null,
  job.followUps !== undefined && job.followUps.length > 0
    ? JSON.stringify(job.followUps)
    : null,
];

const INSERT_SQL = `INSERT INTO cron_jobs (${JOB_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Appends a job. The marker seeds to now: a job cannot have been missed
// before it existed, so occurrences earlier than its creation are not
// its to catch up. The caller owns duplicate-name shaping of the
// user-facing error; a colliding insert still fails loudly here (the
// table's primary key is the backstop).
const insertCronJob = (db: DatabaseSync, job: CronJobConfig): void => {
  db.prepare(INSERT_SQL).run(...jobParams(job), new Date().toISOString());
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
         SET name = ?, schedule = ?, schedule_input = ?, prompt = ?,
             working_dir = ?, timezone = ?, enabled = ?, agent = ?,
             model_provider = ?, model = ?, follow_ups = ?,
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

// Records the occurrence a fire is serving — the missed-run marker.
// Best-effort by contract: the scheduler logs and continues when this
// throws, because a lost write costs at most one duplicate catch-up
// after a later restart, never a missed run.
const recordCronFire = (
  db: DatabaseSync,
  jobName: string,
  occurrence: Date,
): void => {
  db.prepare("UPDATE cron_jobs SET last_fired_at = ? WHERE name = ?").run(
    occurrence.toISOString(),
    jobName,
  );
};

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

export type { CronJobConfig, CronJobRecord };
export {
  backfillCronAgents,
  deleteCronJob,
  insertCronJob,
  listCronJobs,
  openCronDb,
  recordCronFire,
  setCronJobEnabled,
  updateCronJob,
  watchCronJobs,
};
