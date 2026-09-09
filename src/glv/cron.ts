import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Cron } from "croner";
import { type CronJobConfig } from "./cron-jobs.js";
import { pullRepo } from "./git.js";
import { type SessionLauncher, withCreateLock } from "./launch.js";
import { jobModelSelection } from "./models.js";
import {
  getHandle,
  isTerminalStatus,
  type Runner,
  stop,
} from "./runner/index.js";
import {
  fmtDateTime,
  MAX_CRON_STEPS,
  parseOneShotSchedule,
  parseSchedule,
  validTimezone,
} from "./schedule.js";
import { expandHome } from "./server/paths.js";
import { errorMessage, positiveEnvNumber } from "./util.js";

type CronScheduler = {
  /**
   * Re-reads the job set and swaps the schedule if it changed. The
   * watch poll calls this on its interval; UI mutations call it
   * directly so they apply instantly.
   */
  readonly reload: () => void;
  /**
   * Stops every scheduled job and the watch poll. In-flight agent
   * runs keep running.
   */
  readonly stop: () => void;
};

type SchedulerDeps = {
  readonly launcher: SessionLauncher;
  readonly runner: Runner;
  /**
   * Reads cron jobs from the cron database; throws while the store is
   * unreadable.
   */
  readonly readJobs: () => readonly CronJobConfig[];
  /**
   * Registers the change signal: a poll over the cron database, so
   * edits from other processes land within its interval.
   */
  readonly watchJobs: (onChange: () => void) => { readonly stop: () => void };
  /** Records which job started a session, for sidebar recognition. */
  readonly tagSession?: (sessionId: string, jobName: string) => void;
  /**
   * Retires a one-shot job (removes it from the database) once its
   * moment has passed — after it fired, or at boot/reload when it
   * expired unfired.
   */
  readonly retireOneShot?: (jobName: string) => void;
  /**
   * Whether the flavor can honor a model pin (a ModelSource is wired).
   * A pinned job in a flavor without one fails validation, named,
   * instead of silently running on the agent default.
   */
  readonly supportsModels?: boolean;
};

// workingDir canonicalized and `enabled` defaulted so every later
// reference (validation, logs, croner options) sees one spelling.
type ResolvedJob = CronJobConfig & {
  readonly enabled: boolean;
  // Follow-on prompts: after the first prompt's session finishes
  // (completed or errored — only a stop ends the chain early), each
  // starts a new session in the same working directory, in order.
  readonly followUps: readonly string[];
};

// How long one fire waits for the agent to create its session before the
// run is stopped — mirrors the HTTP create flow's poll timeout, but
// generous because nothing is waiting on the answer. The
// GLV_CRON_SESSION_TIMEOUT_MS override shrinks the window so tests can
// observe the timeout path without a minute-long wait.
const DEFAULT_SESSION_TIMEOUT_MS = 60_000;

// How often the chain driver polls a step's run status while waiting for
// it to finish. Terminal handles linger in the registry for ~30s after
// they finish (terminalRetentionMs), which dwarfs this interval, so a
// poll can never miss the terminal state. GLV_CRON_CHAIN_POLL_MS
// overrides it so tests can walk a chain quickly — the same pattern as
// GLV_CRON_SESSION_TIMEOUT_MS.
const DEFAULT_CHAIN_POLL_MS = 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Expands ~ and canonicalizes so the spawn cwd, the per-directory create
// lock, and the flavor's session-discovery poll all see one spelling.
const resolveJobs = (jobs: readonly CronJobConfig[]): readonly ResolvedJob[] =>
  jobs.map((job) => ({
    ...job,
    workingDir: resolve(expandHome(job.workingDir)),
    enabled: job.enabled !== false,
    followUps: job.followUps ?? [],
  }));

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
  const once = parseOneShotSchedule(job.schedule, job.timezone);
  if (once !== undefined && once.getTime() <= Date.now()) return;
  throw invalidSchedule(job, parsed.error);
};

const validateJob = (job: ResolvedJob, supportsModels: boolean): void => {
  if (job.timezone !== undefined && !validTimezone(job.timezone))
    throw new Error(
      `cron job "${job.name}" has an invalid timezone "${job.timezone}"`,
    );
  // Follow-ons only need shape here — non-empty prompts inside the step
  // cap; rows from the store are already trimmed and capped by mapRow,
  // so this is the backstop for direct-API writes.
  if (job.followUps.some((step) => step.trim() === ""))
    throw new Error(`cron job "${job.name}" has an empty follow-on prompt`);
  if (job.followUps.length > MAX_CRON_STEPS - 1)
    throw new Error(
      `cron job "${job.name}" has more than ${MAX_CRON_STEPS - 1} ` +
        `follow-on prompts (the cap is ${MAX_CRON_STEPS} steps in total)`,
    );
  if (job.modelProvider !== undefined && !supportsModels)
    throw new Error(
      `cron job "${job.name}" pins model ` +
        `"${job.modelProvider} / ${job.model}", but this agent does not ` +
        "support model selection",
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
const validateJobs = (
  jobs: readonly ResolvedJob[],
  supportsModels: boolean,
): void => {
  for (const job of jobs) validateJob(job, supportsModels);
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

// Mid-chain liveness: the cron database is re-read before every
// follow-on step. A job deleted or paused since the fire aborts the
// remaining steps (logged) — the user changed their mind mid-pipeline.
// One exception: a one-shot's own retirement must not read as a
// deletion. The scheduler retires one-shots once their moment passes
// (after the fire — or mid-chain when an unrelated edit forces a
// reload), and that is not the user deleting the job. An unreadable
// store is likewise not a pause: the chain keeps going rather than
// dropping a pipeline over a transient read failure.
const chainStillWanted = (
  deps: Pick<SchedulerDeps, "readJobs">,
  job: ResolvedJob,
): boolean => {
  let jobs: readonly CronJobConfig[];
  try {
    jobs = deps.readJobs();
  } catch (err) {
    console.error(
      `cron job "${job.name}": could not re-read the cron database ` +
        `mid-chain (${errorMessage(err)}) — continuing`,
    );
    return true;
  }
  const current = jobs.find((row) => row.name === job.name);
  if (current === undefined) {
    if (parseOneShotSchedule(job.schedule, job.timezone) !== undefined)
      return true;
    console.error(
      `cron job "${job.name}": deleted while its chain was running — ` +
        "remaining steps skipped",
    );
    return false;
  }
  if (current.enabled === false) {
    console.error(
      `cron job "${job.name}": paused while its chain was running — ` +
        "remaining steps skipped",
    );
    return false;
  }
  return true;
};

// One fire of one job, driven as a chain when the job carries follow-on
// prompts. Step 1 is the same establish flow as the HTTP create route —
// pull, start, wait for the agent's session, rekey — minus the HTTP
// concerns (uploads, temp dirs). Each later step starts a brand-new
// session with the step's prompt in the same working directory and
// model pin, inside the same per-directory create lock, tagged with the
// same job name. A step that completes *or errors* advances the chain
// (the runner's in-session rule: an errored run may still have produced
// useful state for the next step); only a stopped run ends it — a user
// who stops a step's session wants the pipeline to halt.
const runFire = async (
  deps: Pick<SchedulerDeps, "launcher" | "runner" | "tagSession" | "readJobs">,
  timeoutMs: number,
  chainPollMs: number,
  job: ResolvedJob,
): Promise<void> => {
  // The repo pull precedes step 1 only: a chain is one logical run over
  // one snapshot, and a mid-chain pull could rebase or move the
  // directory out from under a pipeline that just produced artifacts.
  await pullRepo(job.workingDir);
  const steps = [job.prompt, ...job.followUps];
  for (let index = 0; index < steps.length; index++) {
    if (index > 0 && !chainStillWanted(deps, job)) return;
    const stepLabel = `step ${index + 1}/${steps.length}`;
    const handleKey = deps.launcher.startNew(
      job.workingDir,
      steps[index],
      jobModelSelection(job),
    );
    // Captured right after the enqueue (before awaitNew/establish): the
    // handle object is registered synchronously, and rekey later mutates
    // it in place — the reference stays readable even once the registry
    // evicts it, so the status poll below can never miss the run.
    const handle = getHandle(deps.runner, handleKey);
    const sessionId = await deps.launcher.awaitNew(
      handleKey,
      job.workingDir,
      timeoutMs,
    );
    if (sessionId === undefined) {
      stop(deps.runner, handleKey);
      console.error(
        `cron job "${job.name}" ${stepLabel}: no session was created ` +
          `within ${timeoutMs}ms — run stopped`,
      );
      return;
    }
    const outcome = deps.launcher.establish(
      handleKey,
      sessionId,
      `another session was starting in ${job.workingDir} — cron run stopped`,
    );
    if (!outcome.ok) {
      console.error(`cron job "${job.name}" ${stepLabel}: ${outcome.error}`);
      return;
    }
    deps.tagSession?.(outcome.sessionId, job.name);
    console.log(
      `cron job "${job.name}" ${stepLabel} ` +
        `started session ${outcome.sessionId}`,
    );
    // The last step's session runs unwatched — the fire is done once it
    // is established (exactly today's single-prompt behaviour).
    if (index === steps.length - 1) return;
    if (handle === undefined) {
      // Unreachable by construction (startNew registers the handle
      // synchronously); typed as optional, so guard rather than assert.
      console.error(
        `cron job "${job.name}" ${stepLabel}: run handle missing — ` +
          "chain aborted",
      );
      return;
    }
    while (!isTerminalStatus(handle.status)) await sleep(chainPollMs);
    if (handle.status === "stopped") {
      console.error(
        `cron job "${job.name}" ${stepLabel} was stopped — ` +
          "remaining steps skipped",
      );
      return;
    }
    if (handle.status === "error")
      console.error(
        `cron job "${job.name}" ${stepLabel} errored ` +
          `(${handle.error ?? "unknown error"}) — continuing the chain`,
      );
  }
};

// Serialized per working directory and fully defensive: a scheduled
// callback must never reject.
const fireJob = (
  deps: Pick<SchedulerDeps, "launcher" | "runner" | "tagSession" | "readJobs">,
  locks: Map<string, Promise<void>>,
  timeoutMs: number,
  chainPollMs: number,
  job: ResolvedJob,
): Promise<void> =>
  withCreateLock(locks, job.workingDir, async (): Promise<void> => {
    try {
      await runFire(deps, timeoutMs, chainPollMs, job);
    } catch (err) {
      console.error(`cron job "${job.name}": ${errorMessage(err)}`);
    }
  });

// An invalid reload is logged, not thrown: the previous schedule keeps
// running until the store holds a valid set again.
const logKeptSchedule = (outcome: string, err: unknown): void =>
  console.error(
    `cron: reload ${outcome} — keeping the running schedule (${errorMessage(err)})`,
  );

// Schedules one croner job per stored entry, then watches the cron
// database so later edits apply without a restart. Throws (naming the
// job) on any invalid entry at boot so serve fails fast; an invalid
// *reload* is logged instead and the running schedule kept.
const startCronScheduler = (deps: SchedulerDeps): CronScheduler => {
  // The per-directory locks and in-flight markers outlive reloads, so a
  // rebuilt schedule never doubles runs onto one the previous set started.
  const locks = new Map<string, Promise<void>>();
  const establishing = new Set<string>();
  const timeoutMs = positiveEnvNumber(
    "GLV_CRON_SESSION_TIMEOUT_MS",
    DEFAULT_SESSION_TIMEOUT_MS,
  );
  const chainPollMs = positiveEnvNumber(
    "GLV_CRON_CHAIN_POLL_MS",
    DEFAULT_CHAIN_POLL_MS,
  );
  const scheduled: Cron[] = [];
  let current: readonly ResolvedJob[] = [];

  const retire = (job: ResolvedJob): void => {
    try {
      deps.retireOneShot?.(job.name);
    } catch (err) {
      console.error(
        `cron job "${job.name}": could not retire it from the database — ` +
          errorMessage(err),
      );
    }
  };

  // A fire whose chain (establishment at minimum — the whole chain for
  // a job with follow-ons) is still in flight skips the next tick
  // rather than stacking a second pipeline onto the same directory.
  const fire = (job: ResolvedJob): void => {
    if (establishing.has(job.name)) {
      console.log(
        `cron job "${job.name}": previous run still in flight — ` +
          "fire skipped",
      );
      return;
    }
    establishing.add(job.name);
    const done = fireJob(deps, locks, timeoutMs, chainPollMs, job).finally(
      () => {
        establishing.delete(job.name);
      },
    );
    // A one-shot's moment has passed whatever the outcome; retire it so
    // the database (and the UI reading it) tells the truth.
    if (parseOneShotSchedule(job.schedule, job.timezone) !== undefined)
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
    validateJobs(resolved, deps.supportsModels === true);
    for (const cron of scheduled) cron.stop();
    const effective: ResolvedJob[] = [];
    for (const job of resolved) {
      // A one-shot whose time already passed: never fires late — retire
      // it so the database (and the UI reading it) tells the truth. A
      // missed moment stays missed, whether the job was enabled or
      // paused.
      const once = parseOneShotSchedule(job.schedule, job.timezone);
      if (once !== undefined && once.getTime() <= Date.now()) {
        if (job.enabled)
          console.log(
            `cron job "${job.name}": one-shot time ` +
              `${fmtDateTime(once, job.timezone)} is in the past — ` +
              "removed without running",
          );
        retire(job);
        continue;
      }
      effective.push(job);
      scheduled.push(scheduleJob(job, () => fire(job)));
    }
    return effective;
  };

  // The watch poll fires on its interval whether or not anything
  // changed, so the signature of the last set that was acted on (or
  // rejected, named) suppresses repeat work and repeat log lines — one
  // report per distinct job set, like the file watcher before it.
  let lastOutcome: string | undefined;

  const reload = (): void => {
    let resolved: readonly ResolvedJob[];
    try {
      resolved = resolveJobs(deps.readJobs());
    } catch (err) {
      const failure = `failed: ${errorMessage(err)}`;
      if (failure !== lastOutcome) {
        lastOutcome = failure;
        logKeptSchedule("failed", err);
      }
      return;
    }
    const signature = JSON.stringify(resolved);
    if (signature === lastOutcome) return;
    // An edit that leaves the jobs untouched must not reschedule
    // anything.
    if (signature === JSON.stringify(current)) return;
    try {
      current = applyJobs(resolved);
    } catch (err) {
      logKeptSchedule("rejected", err);
      return;
    } finally {
      lastOutcome = signature;
    }
    console.log(`cron: ${current.length} job(s) scheduled after reload`);
  };

  // Boot is fail-fast: an invalid job set throws out of serve startup.
  current = applyJobs(resolveJobs(deps.readJobs()));
  if (current.length > 0)
    console.log(
      `cron: ${current.length} job(s) scheduled from the cron database`,
    );
  const watcher = deps.watchJobs(reload);

  return {
    reload,
    stop: () => {
      watcher.stop();
      for (const cron of scheduled) cron.stop();
    },
  };
};

export type { CronScheduler };
export { startCronScheduler };
