import type { NamedCronJob } from "../config.js";
import { shortenHome, truncate, truncateMiddle } from "../format/index.js";
import {
  fmtDateTime,
  humanizeSchedule,
  nextFireTimes,
  type ScheduleSelection,
  SELECTION_DEFAULTS,
} from "../schedule.js";

// Views for scheduling: the disclosure + frequency controls inside the
// New Session form, the confirmation banner after a job is saved, and the
// "Scheduled runs" management section (Prompt Library placement and
// styling). Everything is server-rendered; htmx swaps fragments in place.

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

// Cron's day-of-week order: 0 = Sunday.
const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// The restart notice is standing copy: the running serve snapshots jobs
// at boot, so nothing scheduled or edited here is live until it restarts.
const RESTART_NOTICE =
  "Changes apply when glv serve restarts — new and edited jobs start " +
  "firing after the next restart.";

// Cards and the confirmation share these renderings; a job that can no
// longer fire (an expired one-shot) shows a dash instead of pretending.
const humanizeOf = (job: NamedCronJob): string =>
  humanizeSchedule(job.schedule, job.timezone);

const nextRunText = (job: NamedCronJob): string => {
  if (job.enabled === false) return "paused";
  try {
    const runs = nextFireTimes(job.schedule, job.timezone, 1);
    return runs !== undefined && runs.length > 0 ? fmtDateTime(runs[0]) : "—";
  } catch {
    return "—";
  }
};

const TimeInput = ({ name, value }: { name: string; value: string }) => (
  <input
    type="time"
    name={name}
    value={value}
    class="form-input schedule-time"
    step={60}
  />
);

// One frequency option: a radio pill (source-toggle styling) plus the
// inputs that only apply to it. Bodies are toggled purely with CSS :has()
// — same technique as .source-toggle-option:has(input:checked) — so no
// client wiring is needed and htmx swaps keep working. Hidden inputs
// still submit; the server reads only the active kind's fields.
const ScheduleOption = ({
  kind,
  label,
  checked,
  children,
}: {
  kind: string;
  label: string;
  checked: boolean;
  children?: unknown;
}) => (
  <div class="schedule-option" data-schedule-option={kind}>
    <label class="schedule-option-pill">
      <input
        type="radio"
        name="schedule_kind"
        value={kind}
        data-schedule-radio={kind}
        checked={checked}
      />
      <span>{label}</span>
    </label>
    {children !== undefined && (
      <div class="schedule-option-body" data-schedule-body={kind}>
        {children}
      </div>
    )}
  </div>
);

// The frequency controls, shared by the New Session form (Phase 1) and
// the edit form (Phase 2). `values` restores a rejected submit's or an
// existing job's values so nothing typed is ever lost.
const ScheduleControls = ({
  values = SELECTION_DEFAULTS,
}: {
  values?: Omit<ScheduleSelection, "name">;
}) => (
  <div
    class="schedule-options"
    data-schedule-options
    hx-get="/cron/preview"
    hx-trigger="load, change"
    hx-target="find .next-runs-body"
    hx-swap="innerHTML"
    hx-include="find .schedule-fields"
    hx-push-url="false"
  >
    <div class="schedule-fields" data-schedule-fields>
      <ScheduleOption
        kind="once"
        label="Once at"
        checked={values.kind === "once"}
      >
        <span class="schedule-inputs">
          <input
            type="date"
            name="once_date"
            value={values.onceDate}
            class="form-input schedule-date"
          />
          <TimeInput name="once_time" value={values.onceTime} />
        </span>
      </ScheduleOption>
      <ScheduleOption
        kind="daily"
        label="Every day at"
        checked={values.kind === "daily"}
      >
        <span class="schedule-inputs">
          <TimeInput name="daily_time" value={values.dailyTime} />
        </span>
      </ScheduleOption>
      <ScheduleOption
        kind="weekly"
        label="Weekly on"
        checked={values.kind === "weekly"}
      >
        <span class="schedule-inputs">
          <select name="weekly_day" class="form-input schedule-weekday">
            {WEEKDAY_LABELS.map((day, index) => (
              <option
                value={String(index)}
                selected={values.weeklyDay === String(index)}
              >
                {day}
              </option>
            ))}
          </select>
          <TimeInput name="weekly_time" value={values.weeklyTime} />
        </span>
      </ScheduleOption>
      <ScheduleOption
        kind="cron"
        label="Advanced: cron pattern"
        checked={values.kind === "cron"}
      >
        <input
          type="text"
          name="cron_pattern"
          value={values.cronPattern}
          class="form-input schedule-cron-input mono"
          placeholder="0 9 * * 1-5"
          spellcheck={false}
          autocomplete="off"
        />
      </ScheduleOption>
    </div>
    {/* The htmx attributes live on the wrapping container (above) so both
        the fields (hx-include) and this body (hx-target) are descendants;
        change events from the fields bubble up to it. */}
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
  values = SELECTION_DEFAULTS,
  jobName = "",
}: {
  agentName: string;
  values?: Omit<ScheduleSelection, "name">;
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
      <ScheduleControls values={values} />
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

// Edit form reusing the Phase 1 controls, pre-filled from the job. Fields
// the form doesn't expose (e.g. a timezone override) are preserved by the
// PUT route, and called out here so editing is honest about them.
const ScheduleJobEditForm = ({
  job,
  values,
  error,
}: {
  job: NamedCronJob;
  values?: Omit<ScheduleSelection, "name">;
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
        <ScheduleControls values={values} />
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
            Timezone {job.timezone} is kept as configured in the file — the form
            previews and fires in the server&rsquo;s timezone otherwise.
          </p>
        )}
        <div class="prompt-form-actions">
          <button type="submit" class="prompt-save-btn">
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
