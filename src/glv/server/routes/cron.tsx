import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Fragment } from "hono/jsx";
import {
  type CronJobConfig,
  deleteCronJob,
  setCronJobEnabled,
  updateCronJob,
} from "../../cron-jobs.js";
import {
  encodeAgentModelValue,
  jobModelSelection,
  jobModelValue,
  modelPinFields,
  modelUnavailableError,
  pickUnresolved,
} from "../../models.js";
import { fmtDateTime, MAX_CRON_STEPS, parseSchedule } from "../../schedule.js";
import {
  SERVER_TIMEZONE,
  searchTimezones,
  starterSuggestions,
} from "../../timezones.js";
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
import {
  type CronOperations,
  FOLLOW_UPS_CAP_ERROR,
  findJob,
  NAME_ERROR,
  NAME_RE,
  readJobsOr,
  scheduleFields,
  writeJobsOr,
} from "../cron-operations.js";
import { parseForm, stringFields } from "../forms.js";
import { queryValue, sendHtml, sendNotFound } from "../http.js";
import { resolveAgentPick } from "../operations.js";
import { expandHome } from "../paths.js";
import { modelPickerOpts, showsModelPicker } from "../render.js";

// Management surface for scheduled runs. The cron database is the source
// of truth: every mutation writes a row and nudges the scheduler, which
// re-reads the table live — no restart needed. Creates delegate to the
// shared cron operation layer, the same validate-and-execute core the
// JSON API's /api/cron routes call, so both surfaces run identical
// effects.

// First string value of a form field, trimmed (parseBody with all:true
// yields arrays for repeated fields, File for uploads).
const trimmedField = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" ? candidate.trim() : "";
};

// The 500 body shared by the mutations whose database write fails.
const dbWriteError = (error: string) => (
  <p class="status-hint error">Could not update the cron database: {error}</p>
);

const registerCronRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
  cronOps: CronOperations,
): void => {
  // Suggestion fragments for the timezone combobox — <auto-complete> on
  // the form fetches these as the user types; an empty query means the
  // field was focused untouched, so the starter list leads with the
  // server's own zone.
  app.get("/cron/timezones", (request, reply) => {
    const query = queryValue(request, "q") ?? "";
    const suggestions =
      query.trim() === ""
        ? starterSuggestions(SERVER_TIMEZONE)
        : searchTimezones(query);
    return sendHtml(reply, <TimezoneSuggestions suggestions={suggestions} />);
  });

  // Live "Next runs" preview for the typed schedule — the same parse the
  // client bundles and the submit route runs.
  app.get("/cron/preview", (request, reply) => {
    const timezone = queryValue(request, "timezone")?.trim() || undefined;
    const parsed = parseSchedule(queryValue(request, "schedule") ?? "", {
      timezone,
    });
    if (!parsed.ok)
      return sendHtml(
        reply,
        <span class="next-runs-error">{parsed.error}</span>,
      );
    if (parsed.info.next.length === 0)
      return sendHtml(
        reply,
        <span class="next-runs-error">
          This schedule has no upcoming runs.
        </span>,
      );
    return sendHtml(
      reply,
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
  // directory, the agent, and the model all ride along from the New
  // Session form at submit time — the form renders no fields of its own
  // for them.
  app.get("/cron/new", (_request, reply) =>
    sendHtml(reply, <ScheduleSaveForm withModels={showsModelPicker(ctx)} />),
  );

  // Creates a job from the slot form. The New Session form itself stays
  // untouched — the row is written and the confirmation lands in the
  // slot, with the grid and count refreshing out of band. Validation is
  // the shared cron operation layer's (the JSON API runs the identical
  // core); only the two fields composed in the form above get copy
  // here that points back at it.
  app.post("/cron", async (request, reply) => {
    const body: Record<string, unknown> = await parseForm(request);
    const jobName = trimmedField(body, "job_name");
    const schedule = trimmedField(body, "schedule");
    const prompt = trimmedField(body, "prompt");
    const workingDirRaw = trimmedField(body, "working_dir");
    const timezone = trimmedField(body, "timezone");

    const reject = (error: string) =>
      sendHtml(
        reply,
        <ScheduleSaveForm
          jobName={jobName}
          schedule={schedule}
          timezone={timezone}
          withModels={showsModelPicker(ctx)}
          error={error}
        />,
        422,
      );

    if (prompt === "")
      return reject("A prompt is required — type one in the form above.");
    if (workingDirRaw === "")
      return reject(
        "A working directory is required — set one in the form above.",
      );

    const result = cronOps.createJob({
      name: jobName,
      schedule,
      prompt,
      workingDir: workingDirRaw,
      timezone,
      // The combined pick rides in from the New Session form's model
      // select and names both the agent and the model.
      model: trimmedField(body, "model"),
    });
    if (!result.ok) return reject(result.error);

    // Confirmation inline in the slot; the grid and count swap out of
    // band so the new card appears below without touching the slot.
    const { jobs: fresh } = readJobsOr(ctx);
    return sendHtml(
      reply,
      <Fragment>
        <ScheduleConfirmation job={result.job} />
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
  app.get<{ Params: { name: string } }>(
    "/cron/:name/card",
    (request, reply) => {
      const { jobs } = readJobsOr(ctx);
      const job = findJob(jobs, request.params.name);
      if (job === undefined) return sendNotFound(reply);
      return sendHtml(reply, <ScheduleJobCard job={job} />);
    },
  );

  app.get<{ Params: { name: string } }>(
    "/cron/:name/edit",
    (request, reply) => {
      const { jobs } = readJobsOr(ctx);
      const job = findJob(jobs, request.params.name);
      if (job === undefined) return sendNotFound(reply);
      return sendHtml(
        reply,
        <ScheduleJobEditForm
          job={job}
          dirs={ctx.listDirs()}
          modelPicker={modelPickerOpts(
            ctx,
            // The combined picker's spelling of the job's stored agent
            // and pin, so the slot preselects them.
            encodeAgentModelValue(
              job.agent ?? ctx.defaultAgent.id,
              jobModelValue(job),
            ),
          )}
        />,
      );
    },
  );

  app.put<{ Params: { name: string } }>(
    "/cron/:name",
    async (request, reply) => {
      const currentName = request.params.name;
      const { jobs } = readJobsOr(ctx);
      const existing = findJob(jobs, currentName);
      if (existing === undefined) return sendNotFound(reply);
      const body: Record<string, unknown> = await parseForm(request);

      const name = trimmedField(body, "job_name");
      const schedule = trimmedField(body, "schedule");
      const prompt = trimmedField(body, "prompt");
      const workingDirRaw = trimmedField(body, "working_dir");
      const workingDir = resolve(expandHome(workingDirRaw));
      // The combined model select renders whenever the form does and
      // names both the agent and the model; a body without it (a
      // non-browser client) keeps the stored agent and pin.
      const modelPresent = "model" in body;
      const submittedModel = trimmedField(body, "model");
      const { pick, agentId, runtime, modelValue } = resolveAgentPick(
        ctx,
        submittedModel,
        existing.agent ?? ctx.defaultAgent.id,
      );

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

      const reject = (error: string) =>
        sendHtml(
          reply,
          <ScheduleJobEditForm
            job={{ ...existing, name, prompt, workingDir, agent: agentId }}
            schedule={schedule}
            timezone={submittedTimezone}
            followUps={followUpsPresent ? submittedFollowUps : undefined}
            dirs={ctx.listDirs()}
            modelPicker={
              modelPresent ? { submitted: submittedModel } : undefined
            }
            error={error}
          />,
        );

      if (prompt === "") return reject("A prompt is required.");
      if (runtime === undefined)
        return reject(`Agent "${agentId}" is not enabled.`);
      // The picker listed render-time config; resolve the pick against a
      // fresh read in case the agent's config changed since the form was
      // served. An unexposed field keeps whatever the row already pins.
      const picked = modelPresent
        ? runtime.models?.resolve(modelValue)
        : undefined;

      if (!NAME_RE.test(name)) return reject(NAME_ERROR);
      if (workingDirRaw === "")
        return reject("A working directory is required.");
      if (!existsSync(workingDir))
        return reject("That working directory does not exist.");
      const parsed = parseSchedule(schedule, { timezone: submittedTimezone });
      if (!parsed.ok) return reject(parsed.error);
      if (followUps.length > MAX_CRON_STEPS - 1)
        return reject(FOLLOW_UPS_CAP_ERROR);
      if (modelPresent && pickUnresolved(pick, picked))
        return reject(modelUnavailableError(runtime.profile.agentName));
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
          modelPresent ? picked : jobModelSelection({ modelProvider, model }),
        ),
        name,
        ...scheduleFields(schedule, parsed.info.cron),
        prompt,
        workingDir,
        agent: agentId,
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
      return sendHtml(reply, <ScheduleJobCard job={updated} />);
    },
  );

  const toggleJob = (reply: FastifyReply, name: string, enabled: boolean) => {
    const { jobs } = readJobsOr(ctx);
    if (findJob(jobs, name) === undefined) return sendNotFound(reply);
    const writeError = writeJobsOr(ctx, (db) =>
      setCronJobEnabled(db, name, enabled),
    );
    if (writeError !== undefined)
      return sendHtml(reply, dbWriteError(writeError), 500);
    const { jobs: fresh, error } = readJobsOr(ctx);
    if (error !== undefined)
      return sendHtml(reply, <p class="status-hint error">{error}</p>, 500);
    return sendHtml(reply, <ScheduledRunsSection jobs={fresh} />);
  };

  app.post<{ Params: { name: string } }>(
    "/cron/:name/pause",
    (request, reply) => toggleJob(reply, request.params.name, false),
  );
  app.post<{ Params: { name: string } }>(
    "/cron/:name/resume",
    (request, reply) => toggleJob(reply, request.params.name, true),
  );

  app.delete<{ Params: { name: string } }>("/cron/:name", (request, reply) => {
    const name = request.params.name;
    let removed = false;
    const writeError = writeJobsOr(ctx, (db) => {
      removed = deleteCronJob(db, name);
    });
    if (writeError !== undefined)
      return sendHtml(reply, dbWriteError(writeError), 500);
    if (!removed) return sendNotFound(reply);
    const { jobs } = readJobsOr(ctx);
    // The (possibly hidden) section swaps back in, so deleting the last
    // job clears the section from the page.
    return sendHtml(reply, <ScheduledRunsSection jobs={jobs} />);
  });
};

export { registerCronRoutes };
