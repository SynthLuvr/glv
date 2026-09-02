import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Cron } from "croner";
import type { CronJobConfig } from "./config.js";
import { pullRepo } from "./git.js";
import { type SessionLauncher, withCreateLock } from "./launch.js";
import { type Runner, stop } from "./runner/index.js";
import {
  fmtDateTime,
  parseOneShotSchedule,
  parseSchedule,
} from "./schedule.js";
import { expandHome } from "./server/paths.js";
import { errorMessage } from "./util.js";

type CronScheduler = {
  /** Stops every scheduled job. In-flight agent runs keep running. */
  readonly stop: () => void;
};

type SchedulerDeps = {
  readonly launcher: SessionLauncher;
  readonly runner: Runner;
  readonly jobs: readonly CronJobConfig[];
  /** Records which job started a session, for sidebar recognition. */
  readonly tagSession?: (sessionId: string, jobName: string) => void;
  /**
   * Retires a one-shot job (removes it from the config) once its moment
   * has passed — after it fired, or at boot when it expired unfired.
   */
  readonly retireOneShot?: (jobName: string) => void;
};

// name/workingDir canonicalized and `enabled` defaulted so every later
// reference (validation, logs, croner options) sees one spelling.
type ResolvedJob = {
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly workingDir: string;
  readonly timezone?: string;
  readonly enabled: boolean;
};

// How long one fire waits for the agent to create its session before the
// run is stopped — mirrors the HTTP create flow's poll timeout, but
// generous because nothing is waiting on the answer.
const DEFAULT_SESSION_TIMEOUT_MS = 60_000;

// Test-facing override: shrinks the establishment window so the timeout
// path is observable without a minute-long wait.
const sessionTimeoutMs = (): number => {
  const raw = process.env.GLV_CRON_SESSION_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_SESSION_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SESSION_TIMEOUT_MS;
};

// croner accepts any string as a timezone and only misbehaves later, so
// validity is checked here to fail startup with the job named.
const validTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

// Expands ~ and canonicalizes so the spawn cwd, the per-directory create
// lock, and the flavor's session-discovery poll all see one spelling.
const resolveJobs = (jobs: readonly CronJobConfig[]): readonly ResolvedJob[] =>
  jobs.map((job, index) => ({
    ...job,
    name: job.name?.trim() || `cron-${index + 1}`,
    workingDir: resolve(expandHome(job.workingDir)),
    enabled: job.enabled !== false,
  }));

const assertUniqueNames = (jobs: readonly ResolvedJob[]): void => {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.name))
      throw new Error(
        `duplicate cron job name "${job.name}" in the glv config file`,
      );
    seen.add(job.name);
  }
};

const validateJob = (job: ResolvedJob): void => {
  if (job.timezone !== undefined && !validTimezone(job.timezone))
    throw new Error(
      `cron job "${job.name}" has an invalid timezone "${job.timezone}"`,
    );
  // A disabled job may legitimately point at a directory that does not
  // exist yet; an enabled one would fail its very first fire.
  if (job.enabled && !existsSync(job.workingDir))
    throw new Error(
      `cron job "${job.name}" working directory does not exist: ${job.workingDir}`,
    );
};

// Validating (parseSchedule) fails startup with the job named for any
// invalid schedule; an English schedule arrives here already translated
// to its cron pattern, so every job is croner-driven. A disabled job is
// parsed for validation but never given a callback, so it stays dormant.
const scheduleJob = (job: ResolvedJob, fire: () => void): Cron => {
  const parsed = parseSchedule(job.schedule, { timezone: job.timezone });
  if (!parsed.ok)
    throw new Error(
      `cron job "${job.name}" has an invalid schedule ` +
        `"${job.schedule}": ${parsed.error}`,
    );
  const pattern =
    parsed.info.kind === "text"
      ? (parsed.info.cron ?? job.schedule)
      : job.schedule;
  return new Cron(
    pattern,
    { name: job.name, timezone: job.timezone },
    job.enabled ? fire : undefined,
  );
};

// One fire of one job: the same establish flow as the HTTP create route —
// pull, start, wait for the agent's session, rekey — minus the HTTP
// concerns (uploads, temp dirs).
const runFire = async (
  deps: SchedulerDeps,
  timeoutMs: number,
  job: ResolvedJob,
): Promise<void> => {
  await pullRepo(job.workingDir);
  const handle = deps.launcher.startNew(job.workingDir, job.prompt);
  const sessionId = await deps.launcher.awaitNew(
    handle,
    job.workingDir,
    timeoutMs,
  );
  if (sessionId === undefined) {
    stop(deps.runner, handle);
    console.error(
      `cron job "${job.name}": no session was created within ${timeoutMs}ms — run stopped`,
    );
    return;
  }
  const outcome = deps.launcher.establish(
    handle,
    sessionId,
    `another session was starting in ${job.workingDir} — cron run stopped`,
  );
  if (!outcome.ok) {
    console.error(`cron job "${job.name}": ${outcome.error}`);
    return;
  }
  deps.tagSession?.(outcome.sessionId, job.name);
  console.log(`cron job "${job.name}" started session ${outcome.sessionId}`);
};

// Serialized per working directory and fully defensive: a scheduled
// callback must never reject.
const fireJob = (
  deps: SchedulerDeps,
  locks: Map<string, Promise<void>>,
  timeoutMs: number,
  job: ResolvedJob,
): Promise<void> =>
  withCreateLock(locks, job.workingDir, async (): Promise<void> => {
    try {
      await runFire(deps, timeoutMs, job);
    } catch (err) {
      console.error(`cron job "${job.name}": ${errorMessage(err)}`);
    }
  });

// Schedules one croner job per config entry. Returns undefined when no
// jobs are configured; throws (naming the job) on any invalid entry so
// serve fails fast instead of skipping silently.
const startCronScheduler = (deps: SchedulerDeps): CronScheduler | undefined => {
  const jobs = resolveJobs(deps.jobs);
  if (jobs.length === 0) return undefined;
  assertUniqueNames(jobs);

  const locks = new Map<string, Promise<void>>();
  const establishing = new Set<string>();
  const timeoutMs = sessionTimeoutMs();
  const scheduled: Cron[] = [];

  const retire = (job: ResolvedJob): void => {
    try {
      deps.retireOneShot?.(job.name);
    } catch (err) {
      console.error(
        `cron job "${job.name}": could not retire it from the config — ` +
          errorMessage(err),
      );
    }
  };

  for (const job of jobs) {
    validateJob(job);
    // A fire whose establishment (poll + rekey) is still in flight skips
    // the next tick rather than piling runs onto the same directory.
    const fire = (): void => {
      if (establishing.has(job.name)) return;
      establishing.add(job.name);
      const done = fireJob(deps, locks, timeoutMs, job).finally(() => {
        establishing.delete(job.name);
      });
      // A one-shot's moment has passed whatever the outcome; retire it so
      // the config (and the UI reading it) tells the truth.
      if (parseOneShotSchedule(job.schedule) !== undefined)
        void done.then(() => retire(job));
    };
    // One-shot whose time already passed: never fires late — retire it so
    // the config (and the UI reading it) tells the truth. A missed moment
    // stays missed, whether the job was enabled or paused.
    const once = parseOneShotSchedule(job.schedule);
    if (once !== undefined && once.getTime() <= Date.now()) {
      if (job.enabled)
        console.log(
          `cron job "${job.name}": one-shot time ` +
            `${fmtDateTime(once)} is in the past — removed without running`,
        );
      retire(job);
      continue;
    }
    scheduled.push(scheduleJob(job, fire));
  }

  console.log(`cron: ${scheduled.length} job(s) scheduled from the config`);
  return {
    stop: () => {
      for (const cron of scheduled) cron.stop();
    },
  };
};

export type { CronScheduler };
export { startCronScheduler };
