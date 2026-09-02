import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Context, type Hono } from "hono";
import { Fragment } from "hono/jsx";
import {
  appendCronJob,
  deleteCronJob,
  type NamedCronJob,
  readCronJobs,
  writeCronJobs,
} from "../../config.js";
import {
  fmtDateTime,
  parseSchedule,
  withResolvedNames,
} from "../../schedule.js";
import { errorMessage } from "../../util.js";
import {
  CronJobGrid,
  ScheduleConfirmation,
  ScheduleJobCard,
  ScheduleJobEditForm,
  ScheduleSaveForm,
  ScheduledRunsSection,
} from "../../views/schedule.js";
import type { ServerContext } from "../context.js";
import { expandHome } from "../paths.js";

// Management surface for scheduled runs. The config file stays the source
// of truth: every mutation is a read-modify-write of its cronJobs array,
// and every response reminds that serve must restart to pick it up.

// Names must stay URL-safe (they name route params) and human-friendly.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const NAME_ERROR =
  "Job names start with a letter or digit and may use spaces, dots, " +
  "dashes, and underscores (max 64 characters).";

const findJob = (
  jobs: readonly NamedCronJob[],
  name: string,
): NamedCronJob | undefined => jobs.find((job) => job.name === name);

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
        <strong class="next-runs-schedule">{parsed.info.human}</strong>
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
  // directory ride along from the New Session form at submit time.
  app.get("/cron/new", (c) =>
    c.html(<ScheduleSaveForm agentName={ctx.profile.agentName} />),
  );

  // Creates a job from the slot form. The New Session form itself stays
  // untouched — the config file is written and the confirmation lands in
  // the slot, with the grid and count refreshing out of band.
  app.post("/cron", async (c) => {
    const body = (await c.req.parseBody({ all: true })) as Record<
      string,
      unknown
    >;
    const str = (key: string): string => {
      const value = body[key];
      if (Array.isArray(value))
        return typeof value[0] === "string" ? value[0].trim() : "";
      return typeof value === "string" ? value.trim() : "";
    };
    const agentName = ctx.profile.agentName;
    const jobName = str("job_name");
    const schedule = str("schedule");
    const prompt = str("prompt");
    const workingDirRaw = str("working_dir");

    const reject = (error: string) =>
      c.html(
        <ScheduleSaveForm
          agentName={agentName}
          jobName={jobName}
          schedule={schedule}
          error={error}
        />,
        422,
      );

    if (prompt === "")
      return reject("A prompt is required — type one in the form above.");
    if (str("session_mode") === "temp")
      return reject(
        "Scheduled runs need a working directory — switch the form " +
          "above off temporary directories.",
      );
    if (str("model_provider") !== "")
      return reject(
        `Scheduled runs always use ${agentName}’s default model — set ` +
          "the model picker above back to default.",
      );
    if (!NAME_RE.test(jobName)) return reject(NAME_ERROR);
    const workingDir = resolve(expandHome(workingDirRaw));
    if (workingDirRaw === "" || !existsSync(workingDir))
      return reject("That working directory does not exist.");
    const parsed = parseSchedule(schedule);
    if (!parsed.ok) return reject(parsed.error);

    let existing: readonly NamedCronJob[] = [];
    try {
      existing = readJobsOr(ctx).jobs;
    } catch (err) {
      return reject(
        `Could not read the config file: ${errorMessage(err)}`,
      );
    }
    if (existing.some((job) => job.name === jobName))
      return reject(`A scheduled run named "${jobName}" already exists.`);

    const job: NamedCronJob = {
      name: jobName,
      schedule,
      prompt,
      workingDir,
    };
    try {
      appendCronJob(ctx.profile.dataDirName, job);
    } catch (err) {
      return reject(
        `Could not save the scheduled run: ${errorMessage(err)}`,
      );
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
    return c.html(<ScheduleJobEditForm job={job} />);
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
    const str = (key: string): string => {
      const value = body[key];
      if (Array.isArray(value))
        return typeof value[0] === "string" ? value[0].trim() : "";
      return typeof value === "string" ? value.trim() : "";
    };

    const name = str("job_name");
    const schedule = str("schedule");
    const prompt = str("prompt");
    const workingDir = resolve(expandHome(str("working_dir")));

    const reject = (error: string) =>
      c.html(
        <ScheduleJobEditForm
          job={{
            ...existing,
            name,
            prompt,
            workingDir,
            timezone: existing.timezone,
          }}
          schedule={schedule}
          error={error}
        />,
      );

    if (prompt === "") return reject("A prompt is required.");
    if (!NAME_RE.test(name)) return reject(NAME_ERROR);
    if (str("working_dir") === "")
      return reject("A working directory is required.");
    if (!existsSync(workingDir))
      return reject("That working directory does not exist.");
    const parsed = parseSchedule(schedule);
    if (!parsed.ok) return reject(parsed.error);
    // Renaming onto a different existing job collides.
    if (jobs.some((job) => job.name === name && job.name !== existing.name))
      return reject(`A scheduled run named "${name}" already exists.`);

    // Unexposed fields (timezone, enabled, …) survive the edit; only the
    // form's own fields are overwritten.
    const updated: NamedCronJob = {
      ...existing,
      name,
      schedule,
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

export { NAME_ERROR, NAME_RE, registerCronRoutes };
