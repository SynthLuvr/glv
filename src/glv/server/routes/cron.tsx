import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Context, type Hono } from "hono";
import {
  deleteCronJob,
  type NamedCronJob,
  readCronJobs,
  writeCronJobs,
} from "../../config.js";
import {
  buildSchedule,
  detectScheduleSelection,
  fmtDateTime,
  humanizeSchedule,
  nextFireTimes,
  readScheduleSelection,
  type ScheduleSelection,
  withResolvedNames,
} from "../../schedule.js";
import { errorMessage } from "../../util.js";
import {
  ScheduledRunsSection,
  ScheduleJobCard,
  ScheduleJobEditForm,
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
  // Live "Next runs" preview for the schedule controls. Accepts the same
  // fields the form submits (only the active kind's fields matter).
  app.get("/cron/preview", (c) => {
    const selection = readScheduleSelection(c.req.query());
    const built = buildSchedule(selection);
    if (!built.ok)
      return c.html(<span class="next-runs-error">{built.error}</span>);
    let runs: Date[] | undefined;
    try {
      runs = nextFireTimes(built.schedule, undefined, 3);
    } catch (err) {
      return c.html(<span class="next-runs-error">{errorMessage(err)}</span>);
    }
    if (runs === undefined || runs.length === 0)
      return c.html(
        <span class="next-runs-error">
          This schedule has no upcoming runs.
        </span>,
      );
    return c.html(
      <span class="next-runs-value">
        <strong class="next-runs-schedule">
          {humanizeSchedule(built.schedule)}
        </strong>
        <ul class="next-runs-list">
          {runs.map((run) => (
            <li>
              <time>{fmtDateTime(run)}</time>
            </li>
          ))}
        </ul>
      </span>,
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
        values={detectScheduleSelection(job.schedule)}
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
    const str = (key: string): string => {
      const value = body[key];
      if (Array.isArray(value))
        return typeof value[0] === "string" ? value[0].trim() : "";
      return typeof value === "string" ? value.trim() : "";
    };

    const selection = readScheduleSelection(body);
    const name = selection.name;
    const prompt = str("prompt");
    const workingDir = resolve(expandHome(str("working_dir")));

    const reject = (error: string, submitted: ScheduleSelection) =>
      c.html(
        <ScheduleJobEditForm
          job={{
            ...existing,
            name,
            prompt,
            workingDir,
            timezone: existing.timezone,
          }}
          values={submitted}
          error={error}
        />,
      );

    if (prompt === "") return reject("A prompt is required.", selection);
    if (!NAME_RE.test(name)) return reject(NAME_ERROR, selection);
    if (str("working_dir") === "")
      return reject("A working directory is required.", selection);
    if (!existsSync(workingDir))
      return reject("That working directory does not exist.", selection);
    const built = buildSchedule(selection);
    if (!built.ok) return reject(built.error, selection);
    // Renaming onto a different existing job collides.
    if (jobs.some((job) => job.name === name && job.name !== existing.name))
      return reject(
        `A scheduled run named "${name}" already exists.`,
        selection,
      );

    // Unexposed fields (timezone, enabled, …) survive the edit; only the
    // form's own fields are overwritten.
    const updated: NamedCronJob = {
      ...existing,
      name,
      schedule: built.schedule,
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
        selection,
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
