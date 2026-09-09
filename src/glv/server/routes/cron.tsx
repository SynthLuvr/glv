import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Context, type Hono } from "hono";
import { Fragment } from "hono/jsx";
import {
  type CronJobConfig,
  deleteCronJob,
  insertCronJob,
  listCronJobs,
  setCronJobEnabled,
  updateCronJob,
} from "../../cron-jobs.js";
import {
  jobModelSelection,
  jobModelValue,
  modelPinFields,
  modelUnavailableError,
} from "../../models.js";
import { fmtDateTime, MAX_CRON_STEPS, parseSchedule } from "../../schedule.js";
import {
  SERVER_TIMEZONE,
  searchTimezones,
  starterSuggestions,
} from "../../timezones.js";
import { errorMessage } from "../../util.js";
import {
  CronJobGrid,
  ScheduleConfirmation,
  ScheduledRunsSection,
  ScheduleJobCard,
  ScheduleJobEditForm,
  ScheduleSaveForm,
  TimezoneSuggestions,
} from "../../views/schedule.js";
import type { ServerContext } from "../context.js";
import { expandHome } from "../paths.js";
import { hasModelPicker, modelPickerOpts } from "../render.js";

// Management surface for scheduled runs. The cron database is the source
// of truth: every mutation writes a row and nudges the scheduler, which
// re-reads the table live — no restart needed.

// Names must stay URL-safe (they name route params) and human-friendly.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const NAME_ERROR =
  "Job names start with a letter or digit and may use spaces, dots, " +
  "dashes, and underscores (max 64 characters).";

const findJob = (
  jobs: readonly CronJobConfig[],
  name: string,
): CronJobConfig | undefined => jobs.find((job) => job.name === name);

// First string value of a form field, trimmed (parseBody with all:true
// yields arrays for repeated fields).
const trimmedField = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (Array.isArray(value))
    return typeof value[0] === "string" ? value[0].trim() : "";
  return typeof value === "string" ? value.trim() : "";
};

// Every string value of a (repeated) form field, verbatim and in submit
// order — the follow-on steps submit one field per step.
const stringFields = (body: Record<string, unknown>, key: string): string[] => {
  const value = body[key];
  const values =
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string => typeof entry === "string");
};

const FOLLOW_UPS_CAP_ERROR =
  `A scheduled run may have at most ${MAX_CRON_STEPS - 1} follow-on ` +
  `steps — ${MAX_CRON_STEPS} steps in total, the first prompt included.`;

// The section's job list, or an empty list with the read error surfaced
// when the store is unreadable (it was valid at boot, so something
// external broke it); shown instead of a 500.
const readJobsOr = (
  ctx: ServerContext,
): {
  jobs: CronJobConfig[];
  error: string | undefined;
} => {
  if (ctx.cronDb === undefined) return { jobs: [], error: undefined };
  try {
    return { jobs: listCronJobs(ctx.cronDb), error: undefined };
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

// The 500 body shared by the mutations whose database write fails.
const dbWriteError = (error: string) => (
  <p class="status-hint error">Could not update the cron database: {error}</p>
);

const registerCronRoutes = (app: Hono, ctx: ServerContext): void => {
  // Suggestion fragments for the timezone combobox — <auto-complete> on
  // the form fetches these as the user types; an empty query means the
  // field was focused untouched, so the starter list leads with the
  // server's own zone.
  app.get("/cron/timezones", (c) => {
    const query = c.req.query("q") ?? "";
    const suggestions =
      query.trim() === ""
        ? starterSuggestions(SERVER_TIMEZONE)
        : searchTimezones(query);
    return c.html(<TimezoneSuggestions suggestions={suggestions} />);
  });

  // Live "Next runs" preview for the typed schedule — the same parse the
  // client bundles and the submit route runs.
  app.get("/cron/preview", (c) => {
    const timezone = c.req.query("timezone")?.trim() || undefined;
    const parsed = parseSchedule(c.req.query("schedule") ?? "", { timezone });
    if (!parsed.ok)
      return c.html(<span class="next-runs-error">{parsed.error}</span>);
    if (parsed.info.next.length === 0)
      return c.html(
        <span class="next-runs-error">
          This schedule has no upcoming runs.
        </span>,
      );
    return c.html(
      <span class="next-runs-value">
        <strong class="next-runs-schedule">
          {parsed.info.human}
          {parsed.info.cron !== undefined && (
            <span class="next-runs-cron mono"> → {parsed.info.cron}</span>
          )}
        </strong>
        <ul class="next-runs-list">
          {parsed.info.next.map((run) => (
            <li>
              <time>{fmtDateTime(run, timezone)}</time>
            </li>
          ))}
        </ul>
      </span>,
    );
  });

  // The inline schedule form for the section's slot (the Saved prompts
  // "Save current prompt" pattern): the composed prompt, the working
  // directory, and the model all ride along from the New Session form at
  // submit time — the form renders no fields of its own for them.
  app.get("/cron/new", (c) =>
    c.html(<ScheduleSaveForm withModels={hasModelPicker(ctx)} />),
  );

  // Creates a job from the slot form. The New Session form itself stays
  // untouched — the row is written and the confirmation lands in the
  // slot, with the grid and count refreshing out of band.
  app.post("/cron", async (c) => {
    const body = (await c.req.parseBody({ all: true })) as Record<
      string,
      unknown
    >;
    const jobName = trimmedField(body, "job_name");
    const schedule = trimmedField(body, "schedule");
    const prompt = trimmedField(body, "prompt");
    const workingDirRaw = trimmedField(body, "working_dir");
    const modelProvider = trimmedField(body, "model_provider");
    const timezone = trimmedField(body, "timezone");

    const reject = (error: string) =>
      c.html(
        <ScheduleSaveForm
          jobName={jobName}
          schedule={schedule}
          timezone={timezone}
          withModels={hasModelPicker(ctx)}
          error={error}
        />,
        422,
      );

    if (prompt === "")
      return reject("A prompt is required — type one in the form above.");
    // The picker listed render-time config; resolve the pick against a
    // fresh read in case the agent's config changed since the form was
    // served (same rule as the New Session flow).
    const picked = ctx.models?.resolve(modelProvider);
    if (modelProvider !== "" && picked === undefined)
      return reject(modelUnavailableError(ctx.profile.agentName));
    if (!NAME_RE.test(jobName)) return reject(NAME_ERROR);
    if (workingDirRaw === "")
      return reject(
        "A working directory is required — set one in the form above.",
      );
    const workingDir = resolve(expandHome(workingDirRaw));
    if (!existsSync(workingDir))
      return reject("That working directory does not exist.");
    const parsed = parseSchedule(schedule, { timezone });
    if (!parsed.ok) return reject(parsed.error);

    const existing = readJobsOr(ctx).jobs;
    if (existing.some((job) => job.name === jobName))
      return reject(`A scheduled run named "${jobName}" already exists.`);

    // English becomes its cron pattern here — the database stores one
    // canonical spelling.
    const job: CronJobConfig = {
      name: jobName,
      schedule: parsed.info.cron ?? schedule,
      prompt,
      workingDir,
      ...(timezone === "" ? {} : { timezone }),
      ...modelPinFields(picked),
    };
    const writeError = writeJobsOr(ctx, (db) => insertCronJob(db, job));
    if (writeError !== undefined)
      return reject(`Could not save the scheduled run: ${writeError}`);
    // Confirmation inline in the slot; the grid and count swap out of
    // band so the new card appears below without touching the slot.
    const { jobs: fresh } = readJobsOr(ctx);
    return c.html(
      <Fragment>
        <ScheduleConfirmation job={job} />
        <CronJobGrid jobs={fresh} oob />
        <span
          id="scheduled-runs-count"
          class="scheduled-runs-count"
          hx-swap-oob="true"
        >
          {fresh.length}
        </span>
      </Fragment>,
    );
  });

  // Cancel-edit: the plain card back.
  app.get("/cron/:name/card", (c) => {
    const { jobs } = readJobsOr(ctx);
    const job = findJob(jobs, c.req.param("name"));
    if (job === undefined) return c.notFound();
    return c.html(<ScheduleJobCard job={job} />);
  });

  app.get("/cron/:name/edit", (c) => {
    const { jobs } = readJobsOr(ctx);
    const job = findJob(jobs, c.req.param("name"));
    if (job === undefined) return c.notFound();
    return c.html(
      <ScheduleJobEditForm
        job={job}
        dirs={ctx.listDirs()}
        modelPicker={modelPickerOpts(ctx, jobModelValue(job))}
      />,
    );
  });

  app.put("/cron/:name", async (c) => {
    const currentName = c.req.param("name");
    const { jobs } = readJobsOr(ctx);
    const existing = findJob(jobs, currentName);
    if (existing === undefined) return c.notFound();
    const body = (await c.req.parseBody({ all: true })) as Record<
      string,
      unknown
    >;

    const name = trimmedField(body, "job_name");
    const schedule = trimmedField(body, "schedule");
    const prompt = trimmedField(body, "prompt");
    const workingDirRaw = trimmedField(body, "working_dir");
    const workingDir = resolve(expandHome(workingDirRaw));

    // The timezone field is exposed on the edit form; a body without it
    // (a non-browser client) keeps the stored override, while a
    // submitted value replaces it — empty clears it back to the
    // server's clock.
    const timezonePresent = "timezone" in body;
    const submittedTimezone = trimmedField(body, "timezone");

    // Follow-on steps submit one textarea per step, and the form always
    // carries the follow_ups_present marker (a hidden input beside the
    // step blocks): a marker submit that holds no steps clears the
    // stored chain; a body without the marker (a non-browser client)
    // keeps it.
    const followUpsPresent = "follow_ups_present" in body;
    const submittedFollowUps = stringFields(body, "follow_up");
    // Blanks are dropped on save — an emptied step block is a removal,
    // not an error.
    const followUps = submittedFollowUps
      .map((step) => step.trim())
      .filter((step) => step !== "");

    // The picker is exposed only where the flavor supports models; an
    // unexposed field keeps whatever the row already pins.
    const pickerExposed = hasModelPicker(ctx);
    const submittedModel = trimmedField(body, "model_provider");
    const picked = pickerExposed
      ? ctx.models?.resolve(submittedModel)
      : undefined;

    const reject = (error: string) =>
      c.html(
        <ScheduleJobEditForm
          job={{ ...existing, name, prompt, workingDir }}
          schedule={schedule}
          timezone={submittedTimezone}
          followUps={followUpsPresent ? submittedFollowUps : undefined}
          dirs={ctx.listDirs()}
          modelPicker={
            pickerExposed ? { submitted: submittedModel } : undefined
          }
          error={error}
        />,
      );

    if (prompt === "") return reject("A prompt is required.");
    if (!NAME_RE.test(name)) return reject(NAME_ERROR);
    if (workingDirRaw === "") return reject("A working directory is required.");
    if (!existsSync(workingDir))
      return reject("That working directory does not exist.");
    const parsed = parseSchedule(schedule, { timezone: submittedTimezone });
    if (!parsed.ok) return reject(parsed.error);
    if (followUps.length > MAX_CRON_STEPS - 1)
      return reject(FOLLOW_UPS_CAP_ERROR);
    if (pickerExposed && submittedModel !== "" && picked === undefined)
      return reject(modelUnavailableError(ctx.profile.agentName));
    // Renaming onto a different existing job collides.
    if (jobs.some((job) => job.name === name && job.name !== existing.name))
      return reject(`A scheduled run named "${name}" already exists.`);

    // Unexposed fields (enabled, …) survive the edit; only the form's
    // own fields are overwritten. Where the picker is exposed, the
    // submitted value replaces the stored pin — empty clears it. The
    // follow-ons follow the marker: submitted values replace the stored
    // steps, no marker keeps them.
    const {
      modelProvider,
      model,
      timezone: keptTimezone,
      followUps: keptFollowUps,
      ...kept
    } = existing;
    const timezone = timezonePresent
      ? submittedTimezone || undefined
      : keptTimezone;
    const nextFollowUps = followUpsPresent ? followUps : keptFollowUps;
    const updated: CronJobConfig = {
      ...kept,
      ...modelPinFields(
        pickerExposed ? picked : jobModelSelection({ modelProvider, model }),
      ),
      name,
      schedule: parsed.info.cron ?? schedule,
      prompt,
      workingDir,
      ...(timezone === undefined ? {} : { timezone }),
      ...(nextFollowUps !== undefined && nextFollowUps.length > 0
        ? { followUps: nextFollowUps }
        : {}),
    };
    const writeError = writeJobsOr(ctx, (db) =>
      updateCronJob(db, currentName, updated),
    );
    if (writeError !== undefined)
      return reject(
        `Could not save — the cron database rejected the change: ${writeError}`,
      );
    return c.html(<ScheduleJobCard job={updated} />);
  });

  const toggleJob = (c: Context, enabled: boolean) => {
    // The generic Context lacks the route's param typing; the path always
    // supplies the name.
    const name = c.req.param("name") ?? "";
    const { jobs } = readJobsOr(ctx);
    if (findJob(jobs, name) === undefined) return c.notFound();
    const writeError = writeJobsOr(ctx, (db) =>
      setCronJobEnabled(db, name, enabled),
    );
    if (writeError !== undefined) return c.html(dbWriteError(writeError), 500);
    const { jobs: fresh, error } = readJobsOr(ctx);
    if (error !== undefined)
      return c.html(<p class="status-hint error">{error}</p>, 500);
    return c.html(<ScheduledRunsSection jobs={fresh} />);
  };

  app.post("/cron/:name/pause", (c) => toggleJob(c, false));
  app.post("/cron/:name/resume", (c) => toggleJob(c, true));

  app.delete("/cron/:name", (c) => {
    const name = c.req.param("name");
    let removed = false;
    const writeError = writeJobsOr(ctx, (db) => {
      removed = deleteCronJob(db, name);
    });
    if (writeError !== undefined) return c.html(dbWriteError(writeError), 500);
    if (!removed) return c.notFound();
    const { jobs } = readJobsOr(ctx);
    // The (possibly hidden) section swaps back in, so deleting the last
    // job clears the section from the page.
    return c.html(<ScheduledRunsSection jobs={jobs} />);
  });
};

export { registerCronRoutes };
