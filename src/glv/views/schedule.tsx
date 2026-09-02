import type { NamedCronJob } from "../config.js";
import { shortenHome, truncate, truncateMiddle } from "../format/index.js";
import { fmtDateTime, parseSchedule, SCHEDULE_EXAMPLES } from "../schedule.js";

// Views for scheduling: the disclosure with one typed schedule field
// inside the New Session form, the confirmation banner after a job is
// saved, and the "Scheduled runs" management section (Prompt Library
// placement and styling). Everything is server-rendered; htmx swaps
// fragments in place, and /assets/schedule.js validates the typed
// schedule live before the user can click "Schedule run".

const clockIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM7.25 3.75a.75.75 0 0 1 1.5 0v3.5h3.5a.75.75 0 0 1 0 1.5h-4.25a.75.75 0 0 1-.75-.75v-4.25Z" />
  </svg>
);

// The restart notice is standing copy: the running serve snapshots jobs
// at boot, so nothing scheduled or edited here is live until it restarts.
const RESTART_NOTICE =
  "Changes apply when glv serve restarts — new and edited jobs start " +
  "firing after the next restart.";

// Cards and the confirmation share these renderings; a job that can no
// longer fire (an expired one-shot) or no longer parses (hand-edited)
// shows a dash instead of pretending.
const humanizeOf = (job: NamedCronJob): string => {
  const parsed = parseSchedule(job.schedule, { timezone: job.timezone });
  return parsed.ok ? parsed.info.human : job.schedule;
};

const nextRunText = (job: NamedCronJob): string => {
  if (job.enabled === false) return "paused";
  const parsed = parseSchedule(job.schedule, { timezone: job.timezone });
  if (!parsed.ok || parsed.info.next.length === 0) return "—";
  return fmtDateTime(parsed.info.next[0]);
};

// The typed schedule field plus its live server preview. `datalistId`
// differs between the create form and a card's edit form so the id stays
// unique when both are on the page.
const ScheduleControls = ({
  schedule = "",
  datalistId,
}: {
  /** Restores a rejected submit's (or existing job's) schedule. */
  schedule?: string;
  datalistId: string;
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
          list={datalistId}
          class="form-input schedule-input"
          value={schedule}
          placeholder="every weekday at 9:00"
          autocomplete="off"
          spellcheck={false}
        />
        <datalist id={datalistId}>
          {SCHEDULE_EXAMPLES.map((example) => (
            <option value={example} />
          ))}
        </datalist>
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

// The collapsed-by-default disclosure inside the New Session form. While
// open, the form dims the model picker and attachments (schedule mode
// doesn't support them yet) and the submit button becomes "Schedule run"
// — all via CSS :has(), no navigation, no typed work lost.
const ScheduleDisclosure = ({
  agentName,
  schedule = "",
  jobName = "",
}: {
  agentName: string;
  /** Restores a rejected submit's schedule. */
  schedule?: string;
  /** Restores a rejected submit's job name. */
  jobName?: string;
}) => (
  <details class="schedule-disclosure" data-schedule-disclosure>
    <summary class="schedule-summary">
      {clockIcon}
      <span>Schedule…</span>
    </summary>
    <div class="schedule-panel">
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
      <ScheduleControls schedule={schedule} datalistId="schedule-examples" />
      <p class="schedule-mode-note">
        Scheduled runs use {agentName}&rsquo;s default model and can&rsquo;t
        include attachments yet — leave the model picker on {agentName} default
        and the paperclip off.
      </p>
      <p class="schedule-restart-note">{RESTART_NOTICE}</p>
    </div>
  </details>
);

// Success state rendered into the detail pane after a job is saved: the
// job's name, humanized schedule, next run, and the restart notice.
const ScheduleConfirmation = ({ job }: { job: NamedCronJob }) => (
  <section class="schedule-confirmation" data-schedule-confirmation>
    <div class="schedule-confirmation-head">
      {clockIcon}
      <h3>Scheduled run saved</h3>
    </div>
    <dl class="schedule-confirmation-grid">
      <dt>Job</dt>
      <dd>{job.name}</dd>
      <dt>Schedule</dt>
      <dd>{humanizeOf(job)}</dd>
      <dt>Next run</dt>
      <dd>{nextRunText(job)}</dd>
      <dt>Prompt</dt>
      <dd>{truncate(job.prompt, 140)}</dd>
    </dl>
    <p class="schedule-restart-note">{RESTART_NOTICE}</p>
  </section>
);

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
      <p class="cron-job-schedule">{humanizeOf(job)}</p>
      <p class="cron-job-next">
        <span class="cron-job-next-label">Next run</span>{" "}
        <span class="cron-job-next-value">{nextRunText(job)}</span>
      </p>
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
  error,
}: {
  job: NamedCronJob;
  /** Restores a rejected edit's schedule. */
  schedule?: string;
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
          datalistId={`schedule-examples-${name}`}
        />
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
        <p class="schedule-restart-note">{RESTART_NOTICE}</p>
      </form>
    </article>
  );
};

// The management section below the form. Rendered hidden when no jobs
// exist so the page looks exactly like today, while the swap target
// (#scheduled-runs) always exists for the mutation responses.
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
    hidden={jobs.length === 0}
    {...(oob ? { "hx-swap-oob": "true" } : {})}
  >
    <div class="scheduled-runs-head">
      <h3 class="prompt-library-title">Scheduled runs</h3>
      <span class="scheduled-runs-count">{jobs.length}</span>
    </div>
    <p class="scheduled-runs-notice">{RESTART_NOTICE}</p>
    <div class="cron-job-grid">
      {jobs.map((job) => (
        <ScheduleJobCard job={job} />
      ))}
    </div>
  </section>
);

export {
  RESTART_NOTICE,
  ScheduleConfirmation,
  ScheduleControls,
  ScheduleDisclosure,
  ScheduledRunsSection,
  ScheduleJobCard,
  ScheduleJobEditForm,
};
