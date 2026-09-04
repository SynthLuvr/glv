import { Fragment } from "hono/jsx";
import { shortenHome, truncate, truncateMiddle } from "../format/index.js";
import { jobModelSelection, modelLabel } from "../models.js";
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

// The IANA names the runtime itself recognizes — exactly the set the
// schedule parser accepts, offered as datalist suggestions.
const TIMEZONES: readonly string[] = Intl.supportedValuesOf("timeZone");

// The zone an empty timezone field falls back to, named in the field's
// placeholder and hint so "leave it empty" is an informed choice.
const SERVER_TIMEZONE: string =
  Intl.DateTimeFormat().resolvedOptions().timeZone;

// Standing section-level copy: it renders once, and the fragments
// that swap in beside it (form, confirmation, edit form) add no copy.
const LIVE_RELOAD_NOTICE =
  "Changes apply live — the running server watches the config file, so " +
  "new and edited jobs start firing without a restart.";

// A job that can no longer fire (an expired one-shot) or no longer
// parses (hand-edited) shows a dash instead of pretending.
const nextRunText = (job: NamedCronJob): string => {
  if (job.enabled === false) return "paused";
  const parsed = parseSchedule(job.schedule, { timezone: job.timezone });
  if (!parsed.ok || parsed.info.next.length === 0) return "—";
  return fmtDateTime(parsed.info.next[0], job.timezone);
};

// Each form carries its own datalist id, so the save form and an edit
// card can be on the page at once.
const TimezoneDatalist = ({ id }: { id: string }) => (
  <datalist id={id}>
    {TIMEZONES.map((zone) => (
      <option value={zone} />
    ))}
  </datalist>
);

// The typed schedule field plus its live server preview.
const ScheduleControls = ({
  schedule = "",
  timezone = "",
  timezoneDatalistId,
}: {
  /** Restores a rejected submit's (or existing job's) schedule. */
  schedule?: string;
  /** Restores a rejected submit's (or existing job's) timezone. */
  timezone?: string;
  /** Datalist id for the IANA suggestions (unique per form). */
  timezoneDatalistId: string;
}) => (
  <div
    class="schedule-options"
    data-schedule-options
    // Preview fires on load and ~400ms after typing settles. htmx's
    // `find` matches a single element, so the trigger and include are
    // scoped to the fields wrapper: every field inside (schedule,
    // timezone) drives the preview, and two forms on one page never
    // mix their fields.
    hx-get="/cron/preview"
    hx-trigger="load, input changed delay:400ms from:find .schedule-fields"
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
      <label class="form-field">
        <span class="form-label">Timezone</span>
        <input
          type="text"
          name="timezone"
          data-schedule-timezone=""
          class="form-input schedule-input schedule-timezone"
          value={timezone}
          list={timezoneDatalistId}
          placeholder={`Server local (${SERVER_TIMEZONE})`}
          autocomplete="off"
          spellcheck={false}
        />
        <TimezoneDatalist id={timezoneDatalistId} />
        <span class="model-hint">
          IANA name like America/New_York — leave empty to run on the
          server&rsquo;s clock.
        </span>
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

// Home directories offered as datalist suggestions on the edit form's
// working directory field.
const RecentDirsDatalist = ({
  dirs,
  id,
}: {
  dirs: readonly string[];
  id: string;
}) => (
  <datalist id={id}>
    {dirs.map((dir) => (
      <option value={shortenHome(dir)} />
    ))}
  </datalist>
);

// The inline schedule form, loaded into the section's slot by
// "Schedule…" (the Saved prompts save-form pattern). The prompt comes
// from the New Session form above — hx-include pulls that textarea at
// submit time, so the latest typing is scheduled and never duplicated.
// The run's working directory and model are pulled the same way: the
// form above is the page's single set of those fields, so whatever it
// holds when "Schedule run" is clicked is exactly what the job gets.
const ScheduleSaveForm = ({
  jobName = "",
  schedule = "",
  timezone = "",
  withModels,
  error,
}: {
  /** Restores a rejected submit's job name. */
  jobName?: string;
  /** Restores a rejected submit's schedule. */
  schedule?: string;
  /** Restores a rejected submit's timezone. */
  timezone?: string;
  /** Copy flag: the New Session form above carries a model picker. */
  withModels: boolean;
  error?: string;
}) => (
  <form
    class="prompt-form"
    data-schedule-form="save"
    hx-post="/cron"
    hx-target="#cron-save-slot"
    hx-swap="innerHTML"
    hx-include="find input, .new-session-form textarea[name=prompt], .new-session-form input[name=working_dir], .new-session-form select[name=model_provider]"
  >
    {error !== undefined && <p class="status-hint error">{error}</p>}
    <p class="schedule-mode-note">
      Schedules the prompt composed in the form above. Runs use that
      form&rsquo;s working directory{withModels ? " and model" : ""}.
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
    <ScheduleControls
      schedule={schedule}
      timezone={timezone}
      timezoneDatalistId="schedule-timezones"
    />
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
  </form>
);

// Success state rendered into the detail pane after a job is saved: the
// job's name, humanized schedule, and next run.
const ScheduleConfirmation = ({ job }: { job: NamedCronJob }) => {
  const human = humanizeSchedule(job.schedule, job.timezone);
  const model = jobModelSelection(job);
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
        {job.timezone !== undefined && (
          <Fragment>
            <dt>Timezone</dt>
            <dd>{job.timezone}</dd>
          </Fragment>
        )}
        <dt>Next run</dt>
        <dd>{nextRunText(job)}</dd>
        <dt>Working directory</dt>
        <dd class="mono" title={job.workingDir}>
          {truncateMiddle(shortenHome(job.workingDir), 48)}
        </dd>
        {model !== undefined && (
          <Fragment>
            <dt>Model</dt>
            <dd>{modelLabel(model)}</dd>
          </Fragment>
        )}
        <dt>Prompt</dt>
        <dd>{truncate(job.prompt, 140)}</dd>
      </dl>
    </section>
  );
};

// One job card in the management section. Actions are htmx requests
// scoped to the section so the list refreshes in place.
const ScheduleJobCard = ({ job }: { job: NamedCronJob }) => {
  const name = encodeURIComponent(job.name);
  const enabled = job.enabled !== false;
  const model = jobModelSelection(job);
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
      {model !== undefined && (
        <p class="cron-job-model mono" title={modelLabel(model)}>
          {modelLabel(model)}
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
// job. Fields the form doesn't expose (e.g. a paused job's `enabled`)
// are preserved by the PUT route.
const ScheduleJobEditForm = ({
  job,
  schedule,
  timezone,
  dirs = [],
  modelPicker,
  error,
}: {
  job: NamedCronJob;
  /** Restores a rejected edit's schedule. */
  schedule?: string;
  /** Restores a rejected edit's timezone. */
  timezone?: string;
  /** Home directories offered as datalist suggestions. */
  dirs?: readonly string[];
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
        <ScheduleControls
          schedule={schedule ?? job.schedule}
          timezone={timezone ?? job.timezone ?? ""}
          timezoneDatalistId="cron-edit-timezones"
        />
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
            list="cron-edit-dirs"
            value={job.workingDir}
            spellcheck={false}
          />
          <RecentDirsDatalist dirs={dirs} id="cron-edit-dirs" />
        </label>
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
