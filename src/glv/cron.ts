import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Cron } from "croner";
import type { AgentDispatchLauncher } from "./composite-launcher.js";
import { type CronJobConfig } from "./cron-jobs.js";
import { pullRepo } from "./git.js";
import { withCreateLock } from "./launch.js";
import { jobModelSelection } from "./models.js";
import {
  getHandle,
  isTerminalStatus,
  type RunHandle,
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
   * Fires a stored job immediately — the "Run now" path; see
   * CronRunOutcome for what the answer promises.
   */
  readonly runNow: (name: string) => CronRunOutcome;
  /**
   * Stops every scheduled job and the watch poll. In-flight agent
   * runs keep running.
   */
  readonly stop: () => void;
};

// The answer to an immediate-fire request ("Run now"): ok means the
// fire was started, not that it finished — runs proceed in the
// background exactly like a scheduled fire. A failure carries its HTTP
// status and user-facing copy.
type CronRunOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly error: string };

type SchedulerDeps = {
  readonly launcher: AgentDispatchLauncher;
  readonly runner: Runner;
  /**
   * The agents this server serves: a job's agent must be one of them,
   * and only agents with a model source may honor a model pin. Empty
   * disables the checks (app-less tests).
   */
  readonly agents?: readonly {
    readonly id: string;
    readonly hasModels: boolean;
  }[];
  /** The agent jobs without an explicit one belong to. */
  readonly defaultAgent: string;
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
   * Records the occurrence a fire is serving (the job's missed-run
   * marker). Best-effort: a throw is logged and the fire continues.
   */
  readonly recordFire?: (jobName: string, occurrence: Date) => void;
};

// workingDir canonicalized and `enabled` defaulted so every later
// reference (validation, logs, croner options) sees one spelling.
// followUps defaulted for the same reason: a single-prompt job is a
// chain of one. agent defaulted to the server's default so direct-API
// writes without one still fire somewhere.
type ResolvedJob = CronJobConfig & {
  readonly enabled: boolean;
  readonly followUps: readonly string[];
  readonly agent: string;
};

// How long one fire waits for the agent to create its session before the
// run is stopped — mirrors the HTTP create flow's poll timeout, but
// generous because nothing is waiting on the answer. The
// GLV_CRON_SESSION_TIMEOUT_MS override shrinks the window so tests can
// observe the timeout path without a minute-long wait.
const DEFAULT_SESSION_TIMEOUT_MS = 60_000;

// How often the chain driver polls a running step for its terminal
// status. The registry retains terminal handles for ~30s
// (terminalRetentionMs), so a poll this sparse can never miss one.
// GLV_CRON_CHAIN_POLL_MS shrinks it so tests can walk a chain quickly —
// the same override pattern as GLV_CRON_SESSION_TIMEOUT_MS.
const DEFAULT_CHAIN_POLL_MS = 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Expands ~ and canonicalizes so the spawn cwd, the per-directory create
// lock, and the flavor's session-discovery poll all see one spelling.
const resolveJobs = (
  defaultAgent: string,
  jobs: readonly CronJobConfig[],
): readonly ResolvedJob[] =>
  jobs.map((job) => ({
    ...job,
    workingDir: resolve(expandHome(job.workingDir)),
    enabled: job.enabled !== false,
    followUps: job.followUps ?? [],
    agent: job.agent ?? defaultAgent,
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

const validateJob = (job: ResolvedJob, deps: SchedulerDeps): void => {
  if (job.timezone !== undefined && !validTimezone(job.timezone))
    throw new Error(
      `cron job "${job.name}" has an invalid timezone "${job.timezone}"`,
    );
  // Rows from the store arrive already trimmed and capped (mapRow
  // enforces both); this is the backstop for direct-API writes.
  if (job.followUps.some((step) => step.trim() === ""))
    throw new Error(`cron job "${job.name}" has an empty follow-on prompt`);
  if (job.followUps.length > MAX_CRON_STEPS - 1)
    throw new Error(
      `cron job "${job.name}" has more than ${MAX_CRON_STEPS - 1} ` +
        `follow-on prompts (the cap is ${MAX_CRON_STEPS} steps in total)`,
    );
  // The job's agent must be one this server serves — a row naming a
  // disabled or unknown agent (an edit, a hand-edited store) fails
  // named rather than firing through a launcher that would reject it.
  const agentInfo = deps.agents?.find((entry) => entry.id === job.agent);
  if (deps.agents !== undefined && agentInfo === undefined)
    throw new Error(
      `cron job "${job.name}" names agent "${job.agent}", which is not enabled`,
    );
  if (
    job.modelProvider !== undefined &&
    agentInfo !== undefined &&
    !agentInfo.hasModels
  )
    throw new Error(
      `cron job "${job.name}" pins model ` +
        `"${job.modelProvider} / ${job.model}", but ${job.agent} does not ` +
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
  deps: SchedulerDeps,
): void => {
  for (const job of jobs) validateJob(job, deps);
};

// The pattern croner drives for a job: an English schedule as the cron
// pattern it translated to (stores only ever hold the translation),
// cron and one-shot spellings as themselves. Shared by the scheduler
// and the missed-run probe so both sides resolve a schedule — DST
// shifts, nonexistent wall clocks — identically.
const cronPattern = (job: ResolvedJob): string => {
  const parsed = parseSchedule(job.schedule, { timezone: job.timezone });
  if (!parsed.ok) throw invalidSchedule(job, parsed.error);
  return parsed.info.kind === "text"
    ? (parsed.info.cron ?? job.schedule)
    : job.schedule;
};

// Scheduling translates the schedule to what croner drives: an English
// schedule fires as the cron pattern it translates to (every job is
// croner-driven), a one-shot as the ISO date croner runs once. A
// disabled job is still constructed — for validation — but with no
// callback, which croner never schedules. The callback names the
// occurrence it fires: a one-shot's stored instant, else croner's
// currentRun() — the millisecond-stripped moment the timer fired,
// which can only land on or after the occurrence, never before it.
const scheduleJob = (
  job: ResolvedJob,
  fire: (occurrence: Date) => void,
): Cron => {
  const pattern = cronPattern(job);
  return new Cron(
    pattern,
    { name: job.name, timezone: job.timezone },
    job.enabled
      ? (self) => {
          const once = parseOneShotSchedule(job.schedule, job.timezone);
          fire(once ?? self.currentRun() ?? new Date());
        }
      : undefined,
  );
};

// The job's missed-run marker as an instant. Absent — never fired, or
// a marker hand-edited into something unparseable — reads as never
// fired; a recurring job then misses nothing (occurrences before a
// marker-less row existed are not the job's), while a still-present
// one-shot with a past moment is caught up (its row could only still
// exist unfired).
const markerMs = (job: ResolvedJob): number | undefined => {
  if (job.lastFiredAt === undefined) return undefined;
  const ms = Date.parse(job.lastFiredAt);
  return Number.isNaN(ms) ? undefined : ms;
};

// The latest occurrence of a recurring job's schedule in
// (marker, now], or undefined when it missed nothing. A name-less,
// callback-less probe over the same pattern and timezone the live job
// runs — croner never schedules it, and a schedule resolves the same
// on both sides. How many occurrences were missed is deliberately not
// counted: the latest is served, the rest are gone.
const latestMissedOccurrence = (
  job: ResolvedJob,
  now: number,
): Date | undefined => {
  const marker = markerMs(job);
  if (marker === undefined) return undefined;
  let probe: Cron;
  try {
    probe = new Cron(cronPattern(job), { timezone: job.timezone });
  } catch {
    // Unreachable after validation (validateJobs parsed this very
    // schedule); a probe failure must never block the whole reload.
    return undefined;
  }
  const next = probe.nextRun(new Date(marker));
  if (next === null || next.getTime() > now) return undefined;
  const latest = probe.previousRuns(1)[0];
  return latest !== undefined && latest.getTime() > marker ? latest : next;
};

// Mid-chain liveness: the cron database is re-read before every
// follow-on step. A job deleted or paused since the fire aborts the
// remaining steps — the user changed their mind mid-pipeline. Two
// cases must not read as an abort: a one-shot's own retirement (the
// scheduler retires it once its moment passes, which is not a
// deletion), and an unreadable store (a transient read failure must
// not drop a running pipeline).
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

// Starts one step's session and establishes it — the same flow as the
// HTTP create route minus the HTTP concerns. Returns the run handle,
// or undefined with the failure logged.
const startStepSession = async (
  deps: Pick<SchedulerDeps, "launcher" | "runner" | "tagSession">,
  timeoutMs: number,
  job: ResolvedJob,
  prompt: string,
  stepLabel: string,
): Promise<RunHandle | undefined> => {
  const handleKey = deps.launcher.startNewFor(
    job.agent,
    job.workingDir,
    prompt,
    jobModelSelection(job),
  );
  // Captured before establish() rekeys the registry onto the real
  // session id: the handle object is mutated in place and later evicted
  // from the registry, but this reference keeps reporting its status.
  const handle = getHandle(deps.runner, handleKey);
  const sessionId = await deps.launcher.awaitNew(
    handleKey,
    job.workingDir,
    timeoutMs,
  );
  if (sessionId === undefined || handle === undefined) {
    stop(deps.runner, handleKey);
    console.error(
      `cron job "${job.name}" ${stepLabel}: no session was created ` +
        `within ${timeoutMs}ms — run stopped`,
    );
    return undefined;
  }
  const outcome = deps.launcher.establish(
    handleKey,
    sessionId,
    `another session was starting in ${job.workingDir} — cron run stopped`,
  );
  if (!outcome.ok) {
    console.error(`cron job "${job.name}" ${stepLabel}: ${outcome.error}`);
    return undefined;
  }
  deps.tagSession?.(outcome.sessionId, job.name);
  console.log(
    `cron job "${job.name}" ${stepLabel} started session ${outcome.sessionId}`,
  );
  return handle;
};

// Waits for a step's session to finish. `completed` and `error` advance
// the chain — an errored run may still have produced useful state for
// the next step, the runner's own rule; only `stopped` ends it: a user
// who stops a step's session wants the pipeline halted.
const awaitStepSettled = async (
  job: ResolvedJob,
  handle: RunHandle,
  stepLabel: string,
  pollMs: number,
): Promise<boolean> => {
  while (!isTerminalStatus(handle.status)) await sleep(pollMs);
  if (handle.status === "stopped") {
    console.error(
      `cron job "${job.name}" ${stepLabel} was stopped — ` +
        "remaining steps skipped",
    );
    return false;
  }
  if (handle.status === "error")
    console.error(
      `cron job "${job.name}" ${stepLabel} errored ` +
        `(${handle.error ?? "unknown error"}) — continuing the chain`,
    );
  return true;
};

// One fire of one job, driven as a chain when it carries follow-on
// prompts: each step starts a new session in the same working directory
// and model pin once the previous step finishes. The repo pull precedes
// step 1 only — a chain is one logical run over one snapshot, and a
// mid-chain pull could move the directory out from under a pipeline
// that just produced artifacts.
const runFire = async (
  deps: Pick<SchedulerDeps, "launcher" | "runner" | "tagSession" | "readJobs">,
  timeoutMs: number,
  chainPollMs: number,
  job: ResolvedJob,
): Promise<void> => {
  await pullRepo(job.workingDir);
  const steps = [job.prompt, ...job.followUps];
  for (const [index, prompt] of steps.entries()) {
    if (index > 0 && !chainStillWanted(deps, job)) return;
    const stepLabel = `step ${index + 1}/${steps.length}`;
    const handle = await startStepSession(
      deps,
      timeoutMs,
      job,
      prompt,
      stepLabel,
    );
    if (handle === undefined) return;
    // The last step runs unwatched: the fire is done once it is
    // established, exactly the single-prompt behaviour.
    if (index === steps.length - 1) return;
    if (!(await awaitStepSettled(job, handle, stepLabel, chainPollMs))) return;
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
  // a job with follow-ons) is still in flight skips the tick rather
  // than stacking a second pipeline onto the same directory. The
  // occurrence — the scheduled instant this fire serves — is recorded
  // as the missed-run marker before anything is awaited, so a restart
  // mid-fire never re-serves it, and a failed run still counts as
  // served (the same stance the retire-after-fire rule takes). Answers
  // "fired" or "skipped" so an explicit run-now can tell the user the
  // difference; a scheduled tick ignores the answer.
  const fire = (
    job: ResolvedJob,
    occurrence: Date,
    missed: boolean,
  ): "fired" | "skipped" => {
    if (establishing.has(job.name)) {
      console.log(
        `cron job "${job.name}": previous run still in flight — ` +
          "fire skipped",
      );
      return "skipped";
    }
    if (missed)
      console.log(
        `cron job "${job.name}": firing missed run scheduled for ` +
          `${fmtDateTime(occurrence, job.timezone)}`,
      );
    establishing.add(job.name);
    try {
      deps.recordFire?.(job.name, occurrence);
    } catch (err) {
      console.error(
        `cron job "${job.name}": could not record the fire in the ` +
          `cron database (${errorMessage(err)}) — continuing`,
      );
    }
    const done = fireJob(deps, locks, timeoutMs, chainPollMs, job).finally(
      () => {
        establishing.delete(job.name);
      },
    );
    // A one-shot fired at (or after) its own moment has had that moment
    // — retire it so the database (and the UI reading it) tells the
    // truth. A manual early run ("Run now") is not the scheduled
    // moment: the job keeps its appointment.
    const once = parseOneShotSchedule(job.schedule, job.timezone);
    if (once !== undefined && occurrence.getTime() >= once.getTime())
      void done.then(() => retire(job));
    return "fired";
  };

  // An immediate fire of a stored row — the "Run now" path. The row is
  // read fresh (a job deleted or paused since the page loaded is
  // honored), then fired through the same path a scheduled tick takes,
  // in-flight guard included. A paused job may be run now without
  // resuming it, but its working directory must exist all the same —
  // so the row is validated as if enabled: validation waives that
  // check for paused rows, an explicit run cannot.
  const runNow = (name: string): CronRunOutcome => {
    let jobs: readonly CronJobConfig[];
    try {
      jobs = deps.readJobs();
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: `Could not read the cron database: ${errorMessage(err)}`,
      };
    }
    const row = jobs.find((job) => job.name === name);
    if (row === undefined)
      return { ok: false, status: 404, error: `No scheduled run ${name}.` };
    const [job] = resolveJobs(deps.defaultAgent, [row]);
    try {
      validateJob({ ...job, enabled: true }, deps);
    } catch (err) {
      return { ok: false, status: 422, error: errorMessage(err) };
    }
    return fire(job, new Date(), false) === "fired"
      ? { ok: true }
      : {
          ok: false,
          status: 409,
          error:
            `cron job "${job.name}" is still running — wait for it to ` +
            "finish, or stop its session",
        };
  };

  // Swaps the running schedule for a validated job set. Everything that
  // can fail is checked before the old jobs are stopped, so an invalid
  // set never disturbs the running schedule; stopping first also frees
  // each croner name for re-registration by the new set. In-flight runs
  // keep running — same semantics as shutdown. One-shots whose moment
  // already passed are retired instead of scheduled, so the set returned
  // (the one now running) can be smaller than the set given.
  // Adopting a set also adopts its missed moments: every enabled job
  // with an occurrence after its marker and at or before now fires
  // once, immediately, serving that occurrence — the latest one,
  // however many piled up. The rule is occurrence-based, not
  // cause-based: an occurrence missed because the process was down and
  // one missed because the job was paused surface the same way.
  const applyJobs = (
    resolved: readonly ResolvedJob[],
  ): readonly ResolvedJob[] => {
    validateJobs(resolved, deps);
    for (const cron of scheduled) cron.stop();
    const effective: ResolvedJob[] = [];
    const catchUps: { readonly job: ResolvedJob; readonly occurrence: Date }[] =
      [];
    const now = Date.now();
    for (const job of resolved) {
      const once = parseOneShotSchedule(job.schedule, job.timezone);
      if (once !== undefined && once.getTime() <= now) {
        // A one-shot whose moment passed. The still-present row plus
        // the marker decides it: served means the fire happened and
        // only the retirement delete failed — finish that now;
        // unserved means the moment passed unwitnessed (serve down, or
        // the job paused) — fire it once as a catch-up, which retires
        // it after. Disabled jobs never catch up.
        const marker = markerMs(job);
        const served = marker !== undefined && marker >= once.getTime();
        if (!job.enabled || served) {
          if (job.enabled)
            console.log(
              `cron job "${job.name}": one-shot time ` +
                `${fmtDateTime(once, job.timezone)} is in the past — ` +
                "already fired, removed",
            );
          retire(job);
          continue;
        }
        catchUps.push({ job, occurrence: once });
        continue;
      }
      effective.push(job);
      scheduled.push(
        scheduleJob(job, (occurrence) => fire(job, occurrence, false)),
      );
      if (job.enabled) {
        const missed = latestMissedOccurrence(job, now);
        if (missed !== undefined) catchUps.push({ job, occurrence: missed });
      }
    }
    for (const { job, occurrence } of catchUps) fire(job, occurrence, true);
    return effective;
  };

  // The watch poll fires on its interval whether or not anything
  // changed, so the signature of the last set that was acted on (or
  // rejected, named) suppresses repeat work and repeat log lines — one
  // report per distinct job set, like the file watcher before it. The
  // marker never appears in the signature: every fire updates it, and a
  // marker-only change must not reschedule anything — only a change to
  // what runs (schedule, prompt, enabled, …) adopts a new set.
  const signatureOf = (jobs: readonly ResolvedJob[]): string =>
    JSON.stringify(jobs.map((job) => ({ ...job, lastFiredAt: undefined })));

  let lastOutcome: string | undefined;

  const reload = (): void => {
    let resolved: readonly ResolvedJob[];
    try {
      resolved = resolveJobs(deps.defaultAgent, deps.readJobs());
    } catch (err) {
      const failure = `failed: ${errorMessage(err)}`;
      if (failure !== lastOutcome) {
        lastOutcome = failure;
        logKeptSchedule("failed", err);
      }
      return;
    }
    const signature = signatureOf(resolved);
    if (signature === lastOutcome) return;
    // An edit that leaves the jobs untouched must not reschedule
    // anything.
    if (signature === signatureOf(current)) return;
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
  current = applyJobs(resolveJobs(deps.defaultAgent, deps.readJobs()));
  if (current.length > 0)
    console.log(
      `cron: ${current.length} job(s) scheduled from the cron database`,
    );
  const watcher = deps.watchJobs(reload);

  return {
    reload,
    runNow,
    stop: () => {
      watcher.stop();
      for (const cron of scheduled) cron.stop();
    },
  };
};

export type { CronRunOutcome, CronScheduler };
export { startCronScheduler };
