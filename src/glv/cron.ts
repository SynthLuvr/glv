import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Cron } from "croner";
import { type CronJobConfig, watchConfigFile } from "./config.js";
import { pullRepo } from "./git.js";
import { type SessionLauncher, withCreateLock } from "./launch.js";
import { type Runner, stop } from "./runner/index.js";
import {
  fmtDateTime,
  parseOneShotSchedule,
  parseSchedule,
  resolvedCronName,
} from "./schedule.js";
import { expandHome } from "./server/paths.js";
import { errorMessage, positiveEnvNumber } from "./util.js";

type CronScheduler = {
  /**
   * Stops every scheduled job and the config watcher. In-flight agent
   * runs keep running.
   */
  readonly stop: () => void;
};

type SchedulerDeps = {
  readonly launcher: SessionLauncher;
  readonly runner: Runner;
  /**
   * Reads cron jobs from the config file; throws while the file is
   * unreadable or invalid.
   */
  readonly readJobs: () => readonly CronJobConfig[];
  /** Config file path, watched so edits apply without a restart. */
  readonly configPath: string;
  /** Records which job started a session, for sidebar recognition. */
  readonly tagSession?: (sessionId: string, jobName: string) => void;
  /**
   * Retires a one-shot job (removes it from the config) once its moment
   * has passed — after it fired, or at boot/reload when it expired
   * unfired.
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
// generous because nothing is waiting on the answer. The
// GLV_CRON_SESSION_TIMEOUT_MS override shrinks the window so tests can
// observe the timeout path without a minute-long wait.
const DEFAULT_SESSION_TIMEOUT_MS = 60_000;

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
    name: resolvedCronName(job, index),
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

const invalidSchedule = (job: ResolvedJob, error: string): Error =>
  new Error(
    `cron job "${job.name}" has an invalid schedule ` +
      `"${job.schedule}": ${error}`,
  );

// Validating (parseSchedule) fails with the job named for any invalid
// schedule — bad cron, translatable-but-rejected English, or a one-shot
// that is not a real datetime. An expired one-shot is *not* invalid: it
// is retired without running (applyJobs), so validation lets it pass.
// The probe is name-less and never registers anything — croner throws
// when a name is re-registered while a live job holds it; names are only
// claimed once the old schedule has been stopped.
const assertParsableSchedule = (job: ResolvedJob): void => {
  const parsed = parseSchedule(job.schedule, { timezone: job.timezone });
  if (parsed.ok) return;
  const once = parseOneShotSchedule(job.schedule);
  if (once !== undefined && once.getTime() <= Date.now()) return;
  throw invalidSchedule(job, parsed.error);
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
  assertParsableSchedule(job);
};

// Whole-set validation, separate from the running schedule so an edit
// can be checked fully before anything is swapped in.
const validateJobs = (jobs: readonly ResolvedJob[]): void => {
  assertUniqueNames(jobs);
  for (const job of jobs) validateJob(job);
};

// Scheduling translates the schedule to what croner drives: an English
// schedule fires as the cron pattern it translates to (every job is
// croner-driven), a one-shot as the ISO date croner runs once. A
// disabled job is still constructed — for validation — but with no
// callback, which croner never schedules.
const scheduleJob = (job: ResolvedJob, fire: () => void): Cron => {
  const parsed = parseSchedule(job.schedule, { timezone: job.timezone });
  if (!parsed.ok) throw invalidSchedule(job, parsed.error);
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
  deps: Pick<SchedulerDeps, "launcher" | "runner" | "tagSession">,
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
  deps: Pick<SchedulerDeps, "launcher" | "runner" | "tagSession">,
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

// An invalid reload is logged, not thrown: the previous schedule keeps
// running until the file is valid again.
const logKeptSchedule = (outcome: string, err: unknown): void =>
  console.error(
    `cron: config reload ${outcome} — keeping the running schedule (${errorMessage(err)})`,
  );

// Schedules one croner job per config entry, then watches the config file
// so later edits apply without a restart. Throws (naming the job) on any
// invalid entry at boot so serve fails fast; an invalid *reload* is
// logged instead and the running schedule kept.
const startCronScheduler = (deps: SchedulerDeps): CronScheduler => {
  // The per-directory locks and in-flight markers outlive reloads, so a
  // rebuilt schedule never doubles runs onto one the previous set started.
  const locks = new Map<string, Promise<void>>();
  const establishing = new Set<string>();
  const timeoutMs = positiveEnvNumber(
    "GLV_CRON_SESSION_TIMEOUT_MS",
    DEFAULT_SESSION_TIMEOUT_MS,
  );
  const scheduled: Cron[] = [];
  let current: readonly ResolvedJob[] = [];

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

  // A fire whose establishment (poll + rekey) is still in flight skips
  // the next tick rather than piling runs onto the same directory.
  const fire = (job: ResolvedJob): void => {
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

  // Swaps the running schedule for a validated job set. Everything that
  // can fail is checked before the old jobs are stopped, so an invalid
  // set never disturbs the running schedule; stopping first also frees
  // each croner name for re-registration by the new set. In-flight runs
  // keep running — same semantics as shutdown. One-shots whose moment
  // already passed are retired instead of scheduled, so the set returned
  // (the one now running) can be smaller than the set given.
  const applyJobs = (
    resolved: readonly ResolvedJob[],
  ): readonly ResolvedJob[] => {
    validateJobs(resolved);
    for (const cron of scheduled) cron.stop();
    const effective: ResolvedJob[] = [];
    for (const job of resolved) {
      // A one-shot whose time already passed: never fires late — retire
      // it so the config (and the UI reading it) tells the truth. A
      // missed moment stays missed, whether the job was enabled or
      // paused.
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
      effective.push(job);
      scheduled.push(scheduleJob(job, () => fire(job)));
    }
    return effective;
  };

  const reload = (): void => {
    let resolved: readonly ResolvedJob[];
    try {
      resolved = resolveJobs(deps.readJobs());
    } catch (err) {
      logKeptSchedule("failed", err);
      return;
    }
    // An edit that leaves the jobs untouched (e.g. forwardHost) must not
    // reschedule anything.
    if (JSON.stringify(resolved) === JSON.stringify(current)) return;
    try {
      current = applyJobs(resolved);
    } catch (err) {
      logKeptSchedule("rejected", err);
      return;
    }
    console.log(`cron: ${current.length} job(s) scheduled after config reload`);
  };

  // Boot is fail-fast: an invalid job set throws out of serve startup.
  current = applyJobs(resolveJobs(deps.readJobs()));
  if (current.length > 0)
    console.log(`cron: ${current.length} job(s) scheduled from the config`);
  const watcher = watchConfigFile(deps.configPath, reload);

  return {
    stop: () => {
      watcher.stop();
      for (const cron of scheduled) cron.stop();
    },
  };
};

export type { CronScheduler };
export { startCronScheduler };
