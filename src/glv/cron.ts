import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Cron } from "croner";
import type { CronJobConfig } from "./config.js";
import { pullRepo } from "./git.js";
import { type SessionLauncher, withCreateLock } from "./launch.js";
import { type Runner, stop } from "./runner/index.js";
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

// Constructing a Cron parses the pattern, so an invalid schedule fails
// startup with the job's name. A disabled job is still constructed — for
// validation — but with no callback, which croner never schedules.
const scheduleJob = (job: ResolvedJob, fire: () => void): Cron => {
  const options = { name: job.name, timezone: job.timezone };
  try {
    return new Cron(job.schedule, options, job.enabled ? fire : undefined);
  } catch (err) {
    const detail = errorMessage(err);
    throw new Error(
      `cron job "${job.name}" has an invalid schedule "${job.schedule}": ${detail}`,
    );
  }
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

  for (const job of jobs) {
    validateJob(job);
    // A fire whose establishment (poll + rekey) is still in flight skips
    // the next tick rather than piling runs onto the same directory.
    const fire = (): void => {
      if (establishing.has(job.name)) return;
      establishing.add(job.name);
      void fireJob(deps, locks, timeoutMs, job).finally(() => {
        establishing.delete(job.name);
      });
    };
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
