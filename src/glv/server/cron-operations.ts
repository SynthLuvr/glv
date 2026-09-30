import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type CronJobConfig,
  type CronJobRecord,
  deleteCronJob,
  insertCronJob,
  listCronJobs,
} from "../cron-jobs.js";
import {
  modelPinFields,
  modelUnavailableError,
  pickUnresolved,
} from "../models.js";
import { MAX_CRON_STEPS, parseSchedule } from "../schedule.js";
import { errorMessage } from "../util.js";
import type { ServerContext } from "./context.js";
import { resolveAgentPick } from "./operations.js";
import { expandHome } from "./paths.js";

// The shared cron operation layer: the validate-and-execute core of the
// scheduled-run mutations, extracted from the HTML handlers so the JSON
// API and the browser UI run literally the same effects — the same
// stance as the session operation layer. Validation failures come back
// as `{ok: false, status, error}` and each surface decides how to
// render them (an HTML form re-render or a JSON status code).

// Names must stay URL-safe (they name route params) and human-friendly.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const NAME_ERROR =
  "Job names start with a letter or digit and may use spaces, dots, " +
  "dashes, and underscores (max 64 characters).";

const FOLLOW_UPS_CAP_ERROR =
  `A scheduled run may have at most ${MAX_CRON_STEPS - 1} follow-on ` +
  `steps — ${MAX_CRON_STEPS} steps in total, the first prompt included.`;

// One failure any cron operation can surface, HTTP-flavoured (the
// session operation layer's shape).
type CronOperationFailure = {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
};

// The fields a create accepts, already spelled per surface (the HTML
// form's job_name maps to name here). Values are trimmed again below,
// so direct-API writes are normalized exactly like form submits.
type CronJobSubmission = {
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly workingDir: string;
  /** "" names no override — the run fires on the server's clock. */
  readonly timezone: string;
  /**
   * The combined agent/model pick ("agent:provider:model", the New
   * Session picker's spelling); "" or a bare "agent:" keeps the
   * agent's default.
   */
  readonly model: string;
  /** Follow-on prompts, in run order (the JSON API surface). */
  readonly followUps?: readonly string[];
};

type CronCreateOutcome =
  | CronOperationFailure
  | { readonly ok: true; readonly job: CronJobRecord };

type CronDeleteOutcome =
  | CronOperationFailure
  | { readonly ok: true; readonly name: string };

const findJob = (
  jobs: readonly CronJobRecord[],
  name: string,
): CronJobRecord | undefined => jobs.find((job) => job.name === name);

// The schedule pair every save writes: English input becomes its cron
// pattern here, with the typed text kept beside it when it differs so
// the edit form prefills what the user wrote. scheduleInput is always
// set — undefined clears any stale memory when the submit itself
// spelled the canonical form.
const scheduleFields = (
  schedule: string,
  cron: string | undefined,
): Pick<CronJobConfig, "schedule" | "scheduleInput"> => {
  const canonical = cron ?? schedule;
  return {
    schedule: canonical,
    scheduleInput: canonical === schedule ? undefined : schedule,
  };
};

// The section's job list, or an empty list with the read error surfaced
// when the store is unreadable (it was valid at boot, so something
// external broke it); shown instead of a 500.
const readJobsOr = (
  ctx: ServerContext,
): {
  jobs: CronJobRecord[];
  error: string | undefined;
} => {
  if (ctx.cronDb === undefined) return { jobs: [], error: undefined };
  try {
    return {
      jobs: listCronJobs(ctx.cronDb, ctx.defaultAgent.id),
      error: undefined,
    };
  } catch (err) {
    return { jobs: [], error: errorMessage(err) };
  }
};

// Every successful mutation lands in the database first, then nudges
// the scheduler so the new schedule applies immediately.
const writeJobsOr = (
  ctx: ServerContext,
  write: (db: DatabaseSync) => void,
): string | undefined => {
  if (ctx.cronDb === undefined) return "the cron database is not open";
  try {
    write(ctx.cronDb);
  } catch (err) {
    return errorMessage(err);
  }
  ctx.onCronJobsChange?.();
  return undefined;
};

const createCronOperations = (ctx: ServerContext) => {
  // The stored row for a just-written job, read back so the answer is
  // exactly what the store holds (the insert seeds last_fired_at). A
  // read failure right after a successful write is extraordinary; the
  // written shape is the honest fallback.
  const readBack = (job: CronJobConfig): CronJobRecord => {
    const fallback: CronJobRecord = { ...job, enabled: true };
    if (ctx.cronDb === undefined) return fallback;
    try {
      return (
        findJob(listCronJobs(ctx.cronDb, ctx.defaultAgent.id), job.name) ??
        fallback
      );
    } catch {
      return fallback;
    }
  };

  // Creates a job. Validation order matches the browser form's, so the
  // same faulty submit answers with the same error whichever surface
  // received it; the two copy variants that point back at the New
  // Session form stay in the HTML route.
  const createJob = (submission: CronJobSubmission): CronCreateOutcome => {
    const fail = (error: string): CronOperationFailure => ({
      ok: false,
      status: 422,
      error,
    });

    const name = submission.name.trim();
    const schedule = submission.schedule.trim();
    const prompt = submission.prompt.trim();
    const workingDirRaw = submission.workingDir.trim();
    const timezone = submission.timezone.trim();
    // Blanks are dropped on save — an emptied step block is a removal,
    // not an error (the edit form's rule).
    const followUps = (submission.followUps ?? [])
      .map((step) => step.trim())
      .filter((step) => step !== "");

    if (prompt === "") return fail("A prompt is required.");
    const { pick, agentId, runtime, modelValue } = resolveAgentPick(
      ctx,
      submission.model.trim(),
      ctx.defaultAgent.id,
    );
    if (runtime === undefined)
      return fail(`Agent "${agentId}" is not enabled.`);
    // The picker listed render-time config; resolve the pick against a
    // fresh read in case the agent's config changed since the form was
    // served (same rule as the New Session flow).
    const picked = runtime.models?.resolve(modelValue);
    if (pickUnresolved(pick, picked))
      return fail(modelUnavailableError(runtime.profile.agentName));
    if (!NAME_RE.test(name)) return fail(NAME_ERROR);
    if (workingDirRaw === "") return fail("A working directory is required.");
    const workingDir = resolve(expandHome(workingDirRaw));
    if (!existsSync(workingDir))
      return fail("That working directory does not exist.");
    const parsed = parseSchedule(schedule, { timezone });
    if (!parsed.ok) return fail(parsed.error);
    if (followUps.length > MAX_CRON_STEPS - 1)
      return fail(FOLLOW_UPS_CAP_ERROR);
    if (readJobsOr(ctx).jobs.some((job) => job.name === name))
      return fail(`A scheduled run named "${name}" already exists.`);

    const job: CronJobConfig = {
      name,
      ...scheduleFields(schedule, parsed.info.cron),
      prompt,
      workingDir,
      ...(timezone === "" ? {} : { timezone }),
      agent: agentId,
      ...modelPinFields(picked),
      ...(followUps.length > 0 ? { followUps } : {}),
    };
    const writeError = writeJobsOr(ctx, (db) => insertCronJob(db, job));
    if (writeError !== undefined)
      return {
        ok: false,
        status: 500,
        error: `Could not save the scheduled run: ${writeError}`,
      };
    return { ok: true, job: readBack(job) };
  };

  // Removes a job by name; false when nothing matched. One-shots
  // retire themselves through the scheduler once their moment passes —
  // this is the caller-driven exit for everything else.
  const deleteJob = (name: string): CronDeleteOutcome => {
    let removed = false;
    const writeError = writeJobsOr(ctx, (db) => {
      removed = deleteCronJob(db, name);
    });
    if (writeError !== undefined)
      return {
        ok: false,
        status: 500,
        error: `Could not update the cron database: ${writeError}`,
      };
    if (!removed)
      return { ok: false, status: 404, error: `No scheduled run ${name}.` };
    return { ok: true, name };
  };

  return { listJobs: () => readJobsOr(ctx), createJob, deleteJob };
};

type CronOperations = ReturnType<typeof createCronOperations>;

export type { CronCreateOutcome, CronOperations };
export {
  createCronOperations,
  FOLLOW_UPS_CAP_ERROR,
  findJob,
  NAME_ERROR,
  NAME_RE,
  readJobsOr,
  scheduleFields,
  writeJobsOr,
};
