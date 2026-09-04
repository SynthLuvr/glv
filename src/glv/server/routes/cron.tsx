import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Context, type Hono } from "hono";
import { Fragment } from "hono/jsx";
import {
  appendCronJob,
  deleteCronJob,
  readCronJobs,
  writeCronJobs,
} from "../../config.js";
import {
  jobModelSelection,
  jobModelValue,
  modelPinFields,
  modelUnavailableError,
} from "../../models.js";
import {
  fmtDateTime,
  type NamedCronJob,
  parseSchedule,
  withResolvedNames,
} from "../../schedule.js";
import { errorMessage } from "../../util.js";
import {
  CronJobGrid,
  ScheduleConfirmation,
  ScheduledRunsSection,
  ScheduleJobCard,
  ScheduleJobEditForm,
  ScheduleSaveForm,
} from "../../views/schedule.js";
import type { ServerContext } from "../context.js";
import { expandHome } from "../paths.js";
import { hasModelPicker, modelPickerOpts } from "../render.js";

// Management surface for scheduled runs. The config file stays the source
// of truth: every mutation is a read-modify-write of its cronJobs array,
// and the scheduler picks each one up live — no restart needed.

// Names must stay URL-safe (they name route params) and human-friendly.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const NAME_ERROR =
  "Job names start with a letter or digit and may use spaces, dots, " +
  "dashes, and underscores (max 64 characters).";

const findJob = (
  jobs: readonly NamedCronJob[],
  name: string,
): NamedCronJob | undefined => jobs.find((job) => job.name === name);

// First string value of a form field, trimmed (parseBody with all:true
// yields arrays for repeated fields).
const trimmedField = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (Array.isArray(value))
    return typeof value[0] === "string" ? value[0].trim() : "";
  return typeof value === "string" ? value.trim() : "";
};

// A read can only throw when the config file is invalid (it was valid at
// boot, so someone hand-edited it since); surface that instead of a 500.
const readJobsOr = (
  ctx: ServerContext,
): {
  jobs: NamedCronJob[];
  error: string | undefined;
} => {
  try {
    return {
      jobs: withResolvedNames(readCronJobs(ctx.profile.dataDirName)),
      error: undefined,
    };
  } catch (err) {
    return { jobs: [], error: errorMessage(err) };
  }
};

const registerCronRoutes = (app: Hono, ctx: ServerContext): void => {
  // Live "Next runs" preview for the typed schedule — the same parse the
  // client bundles and the submit route runs.
  app.get("/cron/preview", (c) => {
    const parsed = parseSchedule(c.req.query("schedule") ?? "");
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
              <time>{fmtDateTime(run)}</time>
            </li>
          ))}
        </ul>
      </span>,
    );
  });

  // The inline schedule form for the section's slot (the Saved prompts
  // "Save current prompt" pattern): the composed prompt and working
  // directory ride along from the New Session form at submit time. The
  // model picker is the form's own (flavors without models get none).
  app.get("/cron/new", (c) =>
    c.html(
      <ScheduleSaveForm
        agentName={ctx.profile.agentName}
        modelPicker={modelPickerOpts(ctx)}
      />,
    ),
  );

  // Creates a job from the slot form. The New Session form itself stays
  // untouched — the config file is written and the confirmation lands in
  // the slot, with the grid and count refreshing out of band.
  app.post("/cron", async (c) => {
    const body = (await c.req.parseBody({ all: true })) as Record<
      string,
      unknown
    >;
    const agentName = ctx.profile.agentName;
    const jobName = trimmedField(body, "job_name");
    const schedule = trimmedField(body, "schedule");
    const prompt = trimmedField(body, "prompt");
    const workingDirRaw = trimmedField(body, "working_dir");
    const sessionMode = trimmedField(body, "session_mode");
    const modelProvider = trimmedField(body, "model_provider");

    const reject = (error: string) =>
      c.html(
        <ScheduleSaveForm
          agentName={agentName}
          jobName={jobName}
          schedule={schedule}
          modelPicker={modelPickerOpts(ctx, modelProvider)}
          error={error}
        />,
        422,
      );

    if (prompt === "")
      return reject("A prompt is required — type one in the form above.");
    if (sessionMode === "temp")
      return reject(
        "Scheduled runs need a working directory — switch the form " +
          "above off temporary directories.",
      );
    // The picker listed render-time config; resolve the pick against a
    // fresh read in case the agent's config changed since the form was
    // served (same rule as the New Session flow).
    const picked = ctx.models?.resolve(modelProvider);
    if (modelProvider !== "" && picked === undefined)
      return reject(modelUnavailableError(agentName));
    if (!NAME_RE.test(jobName)) return reject(NAME_ERROR);
    const workingDir = resolve(expandHome(workingDirRaw));
    if (workingDirRaw === "" || !existsSync(workingDir))
      return reject("That working directory does not exist.");
    const parsed = parseSchedule(schedule);
    if (!parsed.ok) return reject(parsed.error);

    const existing = readJobsOr(ctx).jobs;
    if (existing.some((job) => job.name === jobName))
      return reject(`A scheduled run named "${jobName}" already exists.`);

    // English becomes its cron pattern here — the file stores one
    // canonical spelling.
    const job: NamedCronJob = {
      name: jobName,
      schedule: parsed.info.cron ?? schedule,
      prompt,
      workingDir,
      ...modelPinFields(picked),
    };
    try {
      appendCronJob(ctx.profile.dataDirName, job);
    } catch (err) {
      return reject(`Could not save the scheduled run: ${errorMessage(err)}`);
    }
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

    // The picker is exposed only where the flavor supports models; an
    // unexposed field keeps whatever the file already pins.
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
    const parsed = parseSchedule(schedule);
    if (!parsed.ok) return reject(parsed.error);
    if (pickerExposed && submittedModel !== "" && picked === undefined)
      return reject(modelUnavailableError(ctx.profile.agentName));
    // Renaming onto a different existing job collides.
    if (jobs.some((job) => job.name === name && job.name !== existing.name))
      return reject(`A scheduled run named "${name}" already exists.`);

    // Unexposed fields (timezone, enabled, …) survive the edit; only the
    // form's own fields are overwritten. Where the picker is exposed,
    // the submitted value replaces the stored pin — empty clears it.
    const { modelProvider, model, ...kept } = existing;
    const updated: NamedCronJob = {
      ...kept,
      ...modelPinFields(
        pickerExposed ? picked : jobModelSelection({ modelProvider, model }),
      ),
      name,
      schedule: parsed.info.cron ?? schedule,
      prompt,
      workingDir,
    };
    try {
      writeCronJobs(
        ctx.profile.dataDirName,
        jobs.map((job) => (job.name === currentName ? updated : job)),
      );
    } catch (err) {
      return reject(
        `Could not save — the config file rejected the change: ${errorMessage(err)}`,
      );
    }
    return c.html(<ScheduleJobCard job={updated} />);
  });

  const toggleJob = (c: Context, enabled: boolean) => {
    // The generic Context lacks the route's param typing; the path always
    // supplies the name.
    const name = c.req.param("name") ?? "";
    const { jobs } = readJobsOr(ctx);
    if (findJob(jobs, name) === undefined) return c.notFound();
    try {
      writeCronJobs(
        ctx.profile.dataDirName,
        jobs.map((job) => (job.name === name ? { ...job, enabled } : job)),
      );
    } catch (err) {
      return c.html(
        <p class="status-hint error">
          Could not update the config file: {errorMessage(err)}
        </p>,
        500,
      );
    }
    const { jobs: fresh, error } = readJobsOr(ctx);
    if (error !== undefined)
      return c.html(<p class="status-hint error">{error}</p>, 500);
    return c.html(<ScheduledRunsSection jobs={fresh} />);
  };

  app.post("/cron/:name/pause", (c) => toggleJob(c, false));
  app.post("/cron/:name/resume", (c) => toggleJob(c, true));

  app.delete("/cron/:name", (c) => {
    const name = c.req.param("name");
    try {
      if (!deleteCronJob(ctx.profile.dataDirName, name)) return c.notFound();
    } catch (err) {
      return c.html(
        <p class="status-hint error">
          Could not update the config file: {errorMessage(err)}
        </p>,
        500,
      );
    }
    const { jobs } = readJobsOr(ctx);
    // The (possibly hidden) section swaps back in, so deleting the last
    // job clears the section from the page.
    return c.html(<ScheduledRunsSection jobs={jobs} />);
  });
};

export { registerCronRoutes };
