import { Fragment } from "hono/jsx";
import { shortenHome, truncate, truncateMiddle } from "../format/index.js";
import {
  fmtDateTime,
  humanizeSchedule,
  type NamedCronJob,
  parseSchedule,
} from "../schedule.js";
import { CLOCK_ICON } from "./chips.js";
import { ModelPickerSlot } from "./new-session.js";

// Views for scheduling: the inline form with its typed schedule field
// and live preview, the confirmation banner after a job is saved, and
// the "Scheduled runs" management section (Prompt Library placement and
// styling). Everything is server-rendered; htmx swaps fragments in
// place, and /assets/schedule.js validates the typed schedule live
// before the user can click "Schedule run".

const clockIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d={CLOCK_ICON} />
  </svg>
);

// The live-reload notice is standing copy: the running serve watches the
// config file, so everything scheduled or edited here applies without a
// restart.
const LIVE_RELOAD_NOTICE =
  "Changes apply live — the running server watches the config file, so " +
  "new and edited jobs start firing without a restart.";

// A job that can no longer fire (an expired one-shot) or no longer
// parses (hand-edited) shows a dash instead of pretending.
const nextRunText = (job: NamedCronJob): string => {
  if (job.enabled === false) return "paused";
  const parsed = parseSchedule(job.schedule, { timezone: job.timezone });
  if (!parsed.ok || parsed.info.next.length === 0) return "—";
  return fmtDateTime(parsed.info.next[0]);
};

// The typed schedule field plus its live server preview.
const ScheduleControls = ({
  schedule = "",
}: {
  /** Restores a rejected submit's (or existing job's) schedule. */
  schedule?: string;
}) => (
  <div
    class="schedule-options"
    data-schedule-options
    // Preview fires on load and ~400ms after typing settles; the input
    // event bubbles to this container and hx-include/reach stay within
    // it, so a page never mixes up two forms' fields.
    hx-get="/cron/preview"
    hx-trigger="load, input changed delay:400ms from:find input"
    hx-target="find .next-runs-body"
    hx-swap="innerHTML"
    hx-include="find .schedule-fields"
    hx-push-url="false"
  >
    <div class="schedule-fields" data-schedule-fields>
      <label class="form-field">
        <span class="form-label">Schedule</span>
        <input
          type="text"
          name="schedule"
          data-schedule-input
          class="form-input schedule-input"
          value={schedule}
          placeholder="every weekday at 9:00"
          autocomplete="off"
          spellcheck={false}
        />
      </label>
      {/* Live as-you-type verdict from /assets/schedule.js; the server
          re-validates on submit regardless. */}
      <p
        class="schedule-validation"
        data-schedule-validation=""
        aria-live="polite"
      >
        Plain English or cron — validated as you type.
      </p>
    </div>
    <div class="next-runs">
      <span class="form-label">Next runs</span>
      <div class="next-runs-body">
        <span class="next-runs-hint">Pick a schedule to preview runs.</span>
      </div>
    </div>
  </div>
);

// The inline schedule form, loaded into the section's slot by
// "Schedule…" (the Saved prompts save-form pattern). It schedules the
// prompt and working directory composed in the New Session form above —
// hx-include pulls those fields at submit time, so the latest typing is
// what gets scheduled, and the composed prompt is never duplicated or
// lost. The model picker is this form's own (same lazy catalogue
// fragment as the New Session form), so a job's model is chosen where
// the job is, independently of whatever the form above would run now.
const ScheduleSaveForm = ({
  agentName,
  jobName = "",
  schedule = "",
  modelPicker,
  error,
}: {
  agentName: string;
  /** Restores a rejected submit's job name. */
  jobName?: string;
  /** Restores a rejected submit's schedule. */
  schedule?: string;
  /** Renders the model picker slot when the flavor supports models;
   * `submitted` restores a rejected submit's selection. */
  modelPicker?: { submitted?: string };
  error?: string;
}) => (
  <form
    class="prompt-form"
    data-schedule-form="save"
    hx-post="/cron"
    hx-target="#cron-save-slot"
    hx-swap="innerHTML"
    hx-include="find input, find select, .new-session-form textarea[name=prompt], .new-session-form input[name=working_dir], .new-session-form input[name=session_mode]"
  >
    {error !== undefined && <p class="status-hint error">{error}</p>}
    <p class="schedule-mode-note">
      Schedules the prompt and working directory composed in the form above —{" "}
      {modelPicker === undefined
        ? `${agentName} runs them with its default model.`
        : `pick a model below, or leave it at ${agentName}’s default.`}
    </p>
    <label class="form-field">
      <span class="form-label">Job name</span>
      <input
        type="text"
        name="job_name"
        class="form-input"
        value={jobName}
        placeholder="e.g. Nightly test sweep"
        maxlength={64}
        autocomplete="off"
      />
    </label>
    <ScheduleControls schedule={schedule} />
    {modelPicker !== undefined && (
      <ModelPickerSlot submitted={modelPicker.submitted} />
    )}
    <div class="prompt-form-actions">
      <button
        type="submit"
        class="prompt-save-btn"
        data-schedule-submit=""
        disabled={schedule === ""}
      >
        Schedule run
      </button>
      <button
        type="button"
        class="prompt-cancel-btn"
        data-action="close-schedule-slot"
      >
        Cancel
      </button>
    </div>
    <p class="schedule-live-note">{LIVE_RELOAD_NOTICE}</p>
  </form>
);

// Success state rendered into the detail pane after a job is saved: the
// job's name, humanized schedule, next run, and the live-reload notice.
const ScheduleConfirmation = ({ job }: { job: NamedCronJob }) => {
  const human = humanizeSchedule(job.schedule, job.timezone);
  return (
    <section class="schedule-confirmation" data-schedule-confirmation>
      <div class="schedule-confirmation-head">
        {clockIcon}
        <h3>Scheduled run saved</h3>
      </div>
      <dl class="schedule-confirmation-grid">
        <dt>Job</dt>
        <dd>{job.name}</dd>
        <dt>Schedule</dt>
        <dd>
          {human}
          {human !== job.schedule && (
            <span class="cron-pattern mono"> ({job.schedule})</span>
          )}
        </dd>
        <dt>Next run</dt>
        <dd>{nextRunText(job)}</dd>
        {job.modelProvider !== undefined && job.model !== undefined && (
          <Fragment>
            <dt>Model</dt>
            <dd>
              {job.modelProvider} / {job.model}
            </dd>
          </Fragment>
        )}
        <dt>Prompt</dt>
        <dd>{truncate(job.prompt, 140)}</dd>
      </dl>
      <p class="schedule-live-note">{LIVE_RELOAD_NOTICE}</p>
    </section>
  );
};

// One job card in the management section. Actions are htmx requests
// scoped to the section so the list refreshes in place.
const ScheduleJobCard = ({ job }: { job: NamedCronJob }) => {
  const name = encodeURIComponent(job.name);
  const enabled = job.enabled !== false;
  return (
    <article class="cron-job-card" data-cron-job={job.name}>
      <div class="cron-job-head">
        <h4 class="cron-job-title">{job.name}</h4>
        <span
          class={`cron-job-status${enabled ? "" : " paused"}`}
          title={enabled ? "Enabled — fires on schedule" : "Paused"}
        >
          {enabled ? "Enabled" : "Paused"}
        </span>
      </div>
      <p class="cron-job-schedule">
        {humanizeSchedule(job.schedule, job.timezone)}
      </p>
      <p class="cron-job-next">
        <span class="cron-job-next-label">Next run</span>{" "}
        <span class="cron-job-next-value">{nextRunText(job)}</span>
      </p>
      {job.modelProvider !== undefined && job.model !== undefined && (
        <p
          class="cron-job-model mono"
          title={`${job.modelProvider} / ${job.model}`}
        >
          {job.modelProvider} / {job.model}
        </p>
      )}
      <p class="cron-job-prompt" title={job.prompt}>
        {truncate(job.prompt.replace(/\s+/g, " "), 140)}
      </p>
      <p class="cron-job-dir mono" title={job.workingDir}>
        {truncateMiddle(shortenHome(job.workingDir), 48)}
      </p>
      <div class="cron-job-actions">
        <button
          type="button"
          class="prompt-card-btn"
          hx-post={`/cron/${name}/${enabled ? "pause" : "resume"}`}
          hx-target="#scheduled-runs"
          hx-swap="outerHTML"
        >
          {enabled ? "Pause" : "Resume"}
        </button>
        <button
          type="button"
          class="prompt-card-btn edit"
          hx-get={`/cron/${name}/edit`}
          hx-target="closest .cron-job-card"
          hx-swap="outerHTML"
        >
          Edit
        </button>
        <button
          type="button"
          class="prompt-card-btn delete"
          hx-delete={`/cron/${name}`}
          hx-target="#scheduled-runs"
          hx-swap="outerHTML"
          hx-confirm="Delete this scheduled run? Sessions it already started are kept."
        >
          Delete
        </button>
      </div>
    </article>
  );
};

// Edit form reusing the typed-schedule controls, pre-filled from the
// job. Fields the form doesn't expose (e.g. a timezone override) are
// preserved by the PUT route, and called out here so editing is honest
// about them.
const ScheduleJobEditForm = ({
  job,
  schedule,
  modelPicker,
  error,
}: {
  job: NamedCronJob;
  /** Restores a rejected edit's schedule. */
  schedule?: string;
  /** Renders the model picker slot when the flavor supports models;
   * `submitted` preselects the job's stored model (or a rejected edit's
   * pick). Without it, a stored model pin is preserved untouched. */
  modelPicker?: { submitted?: string };
  error?: string;
}) => {
  const name = encodeURIComponent(job.name);
  return (
    <article class="cron-job-card editing" data-cron-job={job.name}>
      <form
        class="prompt-form"
        hx-put={`/cron/${name}`}
        hx-target="closest .cron-job-card"
        hx-swap="outerHTML"
      >
        {error !== undefined && <p class="status-hint error">{error}</p>}
        <label class="form-field">
          <span class="form-label">Job name</span>
          <input
            type="text"
            name="job_name"
            class="form-input"
            value={job.name}
            maxlength={64}
            autocomplete="off"
          />
        </label>
        <ScheduleControls schedule={schedule ?? job.schedule} />
        {modelPicker !== undefined && (
          <ModelPickerSlot submitted={modelPicker.submitted} />
        )}
        <label class="form-field">
          <span class="form-label">Prompt</span>
          <textarea name="prompt" class="form-input" rows={4}>
            {job.prompt}
          </textarea>
        </label>
        <label class="form-field">
          <span class="form-label">Working directory</span>
          <input
            type="text"
            name="working_dir"
            class="form-input mono"
            value={job.workingDir}
            spellcheck={false}
          />
        </label>
        {job.timezone !== undefined && (
          <p class="cron-job-kept-note">
            Timezone {job.timezone} is kept as configured in the file — it
            applies to cron schedules; typed schedules always fire in the
            server&rsquo;s timezone.
          </p>
        )}
        <div class="prompt-form-actions">
          <button type="submit" class="prompt-save-btn" data-schedule-submit="">
            Save
          </button>
          <button
            type="button"
            class="prompt-cancel-btn"
            hx-get={`/cron/${name}/card`}
            hx-target="closest .cron-job-card"
            hx-swap="outerHTML"
          >
            Cancel
          </button>
        </div>
        <p class="schedule-live-note">{LIVE_RELOAD_NOTICE}</p>
      </form>
    </article>
  );
};

// The job grid carries its own id so creation can refresh it out of
// band without touching the save slot above it.
const CronJobGrid = ({
  jobs,
  oob = false,
}: {
  jobs: readonly NamedCronJob[];
  oob?: boolean;
}) => (
  <div
    id="cron-job-grid"
    class="cron-job-grid"
    {...(oob ? { "hx-swap-oob": "outerHTML" } : {})}
  >
    {jobs.length === 0 && (
      <p class="cron-job-empty">
        No scheduled runs yet. Use “Schedule…” to schedule the prompt above.
      </p>
    )}
    {jobs.map((job) => (
      <ScheduleJobCard job={job} />
    ))}
  </div>
);

// The management section below the form — Saved prompts placement and
// styling, always present: the header's "Schedule…" button is how a run
// gets scheduled in the first place. The slot holds the inline form (or
// the confirmation after a save); the grid below lists every job.
const ScheduledRunsSection = ({
  jobs,
  oob = false,
}: {
  jobs: readonly NamedCronJob[];
  oob?: boolean;
}) => (
  <section
    id="scheduled-runs"
    class="scheduled-runs-section"
    {...(oob ? { "hx-swap-oob": "true" } : {})}
  >
    <div class="scheduled-runs-head">
      <div class="scheduled-runs-title">
        <h3 class="prompt-library-title">Scheduled runs</h3>
        <span id="scheduled-runs-count" class="scheduled-runs-count">
          {jobs.length}
        </span>
      </div>
      <button
        type="button"
        class="prompt-save-toggle"
        data-action="open-schedule"
        hx-get="/cron/new"
        hx-target="#cron-save-slot"
        hx-swap="innerHTML"
      >
        🕒 Schedule…
      </button>
    </div>
    {/* Swapped in by htmx on demand; empty until the user opens it. */}
    <div id="cron-save-slot" class="prompt-save-slot"></div>
    <p class="scheduled-runs-notice">{LIVE_RELOAD_NOTICE}</p>
    <CronJobGrid jobs={jobs} />
  </section>
);

export {
  CronJobGrid,
  ScheduleConfirmation,
  ScheduledRunsSection,
  ScheduleJobCard,
  ScheduleJobEditForm,
  ScheduleSaveForm,
};
