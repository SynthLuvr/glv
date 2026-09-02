import { Cron } from "croner";
import type { CronJobConfig, NamedCronJob } from "./config.js";
import { errorMessage } from "./util.js";

// Pure helpers around a job's `schedule` string. A schedule is either a
// cron pattern ("0 9 * * 1-5") or an ISO 8601 local datetime
// ("2026-09-03T09:00") — croner treats the latter as fire-once, and these
// helpers keep every producer (form, config file) and consumer (scheduler,
// preview, cards) on one spelling.

// The shape the New Session form submits and the preview endpoint reads.
type ScheduleSelection = {
  readonly kind: "once" | "daily" | "weekly" | "cron";
  readonly name: string;
  readonly onceDate: string;
  readonly onceTime: string;
  readonly dailyTime: string;
  readonly weeklyDay: string;
  readonly weeklyTime: string;
  readonly cronPattern: string;
};

type ScheduleBuild =
  | { readonly ok: true; readonly schedule: string }
  | { readonly ok: false; readonly error: string };

const SELECTION_DEFAULTS: ScheduleSelection = {
  kind: "daily",
  name: "",
  onceDate: "",
  onceTime: "09:00",
  dailyTime: "09:00",
  weeklyDay: "1",
  weeklyTime: "09:00",
  cronPattern: "",
};

// Submitted form field name → selection property.
const FIELD_MAP: Readonly<
  Record<string, keyof Omit<ScheduleSelection, "kind">>
> = {
  job_name: "name",
  once_date: "onceDate",
  once_time: "onceTime",
  daily_time: "dailyTime",
  weekly_day: "weeklyDay",
  weekly_time: "weeklyTime",
  cron_pattern: "cronPattern",
};

// Field-by-field read of a submitted body (form or query params). Fields
// that are present-but-empty override the defaults (a blank time must
// surface as an error, not silently become 09:00); fields that are
// missing entirely keep the defaults.
const readScheduleSelection = (
  body: Record<string, unknown>,
): ScheduleSelection => {
  const raw = (key: string): string | undefined => {
    const value = body[key];
    if (value === undefined) return undefined;
    if (Array.isArray(value))
      return typeof value[0] === "string" ? value[0].trim() : "";
    return typeof value === "string" ? value.trim() : "";
  };
  const selection: Record<string, string> = { ...SELECTION_DEFAULTS };
  for (const [field, prop] of Object.entries(FIELD_MAP)) {
    const value = raw(field);
    if (value !== undefined) selection[prop] = value;
  }
  const kind = raw("schedule_kind");
  return {
    ...selection,
    kind:
      kind === "once" || kind === "weekly" || kind === "cron" ? kind : "daily",
  } as ScheduleSelection;
};

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// ISO-local datetimes (what the form writes) plus full ISO with a zone
// (what Date#toISOString writes) — both are fire-once inputs for croner.
const ONE_SHOT_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

const parseTime = (raw: string): { h: number; m: number } | undefined => {
  const match = TIME_RE.exec(raw);
  if (match === null) return undefined;
  return { h: Number(match[1]), m: Number(match[2]) };
};

// "9:5" style typos are rejected, not silently coerced; the caller turns
// undefined into a plain-language form error.
const validTime = (raw: string): boolean => parseTime(raw) !== undefined;

const twoDigits = (n: number): string => String(n).padStart(2, "0");

const fmtTime = (h: number, m: number): string =>
  `${twoDigits(h)}:${twoDigits(m)}`;

// The one-shot spelling the form produces: local ISO to minute precision.
const formatOneShotLocal = (date: Date): string =>
  `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(
    date.getDate(),
  )}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;

// Returns the instant a fire-once schedule targets, or undefined for cron
// patterns (and malformed values). Calendar validity is checked by
// round-tripping the parsed components.
const parseOneShotSchedule = (schedule: string): Date | undefined => {
  if (!ONE_SHOT_RE.test(schedule)) return undefined;
  const time = Date.parse(schedule.replace(" ", "T"));
  if (Number.isNaN(time)) return undefined;
  const date = new Date(time);
  if (
    date.getUTCFullYear() < 1990 ||
    date.getUTCFullYear() > 9999 ||
    date.getTime() < 0
  )
    return undefined;
  // Zone-less ISO strings roll impossible dates over silently (Feb 30 →
  // Mar 2), so a local spelling is only valid when it round-trips.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(schedule))
    if (formatOneShotLocal(date) !== schedule) return undefined;

  return date;
};

const friendlyCronError = (detail: string): string =>
  `That doesn’t look like a cron pattern — try something like "0 9 * * 1-5" ` +
  `(at 09:00 on weekdays). Details: ${detail}`;

// Validates a raw cron pattern exactly the way serve will (by
// constructing croner's Cron), with the technical message wrapped in
// plain language.
const validateCronPattern = (pattern: string): string | undefined => {
  const fields = pattern.split(/\s+/);
  if (fields.length < 5 || fields.length > 7)
    return friendlyCronError(
      `expected 5 to 7 space-separated fields, got ${fields.length}`,
    );
  try {
    new Cron(pattern);
    return undefined;
  } catch (err) {
    return friendlyCronError(errorMessage(err).replace(/^CronPattern:\s*/, ""));
  }
};

// The cron day-of-week field is 0-6 with Sunday 0 (croner's default).
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const weekdayLabel = (value: string): string => {
  const index = Number(value);
  return WEEKDAYS[index] ?? value;
};

// Turns the form's selection into the schedule string stored in the
// config file, validating every field with errors a human can act on.
const buildSchedule = (
  selection: ScheduleSelection,
  now: Date = new Date(),
): ScheduleBuild => {
  switch (selection.kind) {
    case "once": {
      if (!DATE_RE.test(selection.onceDate))
        return { ok: false, error: "Pick a date for the one-time run." };
      if (!validTime(selection.onceTime))
        return {
          ok: false,
          error: "The time must look like 09:00 (24-hour clock).",
        };
      const schedule = `${selection.onceDate}T${selection.onceTime}`;
      const instant = parseOneShotSchedule(schedule);
      // Reject impossible calendar dates (Feb 30) and instants already past.
      if (instant === undefined || Number.isNaN(instant.getTime()))
        return { ok: false, error: "That date does not exist." };
      if (instant.getTime() <= now.getTime())
        return {
          ok: false,
          error: "That time is already in the past — pick a future one.",
        };
      return { ok: true, schedule };
    }
    case "daily": {
      const daily = parseTime(selection.dailyTime);
      if (daily === undefined)
        return {
          ok: false,
          error: "The time must look like 09:00 (24-hour clock).",
        };
      return { ok: true, schedule: `${daily.m} ${daily.h} * * *` };
    }
    case "weekly": {
      const weekly = parseTime(selection.weeklyTime);
      if (weekly === undefined)
        return {
          ok: false,
          error: "The time must look like 09:00 (24-hour clock).",
        };
      const day = Number(selection.weeklyDay);
      if (!Number.isInteger(day) || day < 0 || day > 6)
        return { ok: false, error: "Pick a weekday for the weekly run." };
      return { ok: true, schedule: `${weekly.m} ${weekly.h} * * ${day}` };
    }
    case "cron": {
      if (selection.cronPattern === "")
        return { ok: false, error: "Enter a cron pattern (e.g. 0 9 * * 1-5)." };
      const error = validateCronPattern(selection.cronPattern);
      if (error !== undefined) return { ok: false, error };
      return { ok: true, schedule: selection.cronPattern };
    }
  }
};

// Infers the form selection a stored schedule maps back to, so editing a
// job pre-fills the controls it was created with. Anything non-trivial
// lands on the cron escape hatch.
const detectScheduleSelection = (
  schedule: string,
): Omit<ScheduleSelection, "name"> => {
  const selection = {
    ...SELECTION_DEFAULTS,
    onceDate: "",
    onceTime: "09:00",
    dailyTime: "09:00",
    weeklyDay: "1",
    weeklyTime: "09:00",
    cronPattern: schedule,
  };
  const once = parseOneShotSchedule(schedule);
  if (once !== undefined)
    return {
      ...selection,
      kind: "once",
      onceDate: schedule.slice(0, 10),
      onceTime: schedule.slice(11, 16),
      cronPattern: "",
    };
  const fields = schedule.split(/\s+/);
  const parts =
    fields.length === 6 && fields[0] === "0" ? fields.slice(1) : fields;
  if (parts.length === 5) {
    const [minute, hour, dom, month, dow] = parts;
    if (dom === "*" && month === "*") {
      const plainTime = /^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour);
      if (!plainTime) return selection;
      const time = fmtTime(Number(hour), Number(minute));
      if (dow === "*")
        return {
          ...selection,
          kind: "daily",
          dailyTime: time,
          cronPattern: "",
        };
      if (/^\d$/.test(dow))
        return {
          ...selection,
          kind: "weekly",
          weeklyDay: dow,
          weeklyTime: time,
          cronPattern: "",
        };
    }
  }
  return selection;
};

// The next `count` fire times, or undefined when the schedule never fires
// again (a one-shot whose moment has passed). Invalid schedules throw —
// callers validate first.
const nextFireTimes = (
  schedule: string,
  timezone: string | undefined,
  count: number,
): Date[] | undefined => {
  const cron = new Cron(schedule, { timezone });
  return cron.nextRuns(count);
};

const fmtDateTime = (date: Date): string =>
  date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

// Plain-language rendering of a schedule, cron second. "Every day at
// 09:00" for the shapes the form generates, the raw pattern otherwise.
const humanizeSchedule = (schedule: string, timezone?: string): string => {
  const tzSuffix = timezone === undefined ? "" : ` (${timezone})`;
  const once = parseOneShotSchedule(schedule);
  if (once !== undefined) return `Once at ${fmtDateTime(once)}${tzSuffix}`;
  const fields = schedule.split(/\s+/);
  const parts =
    fields.length === 6 && fields[0] === "0" ? fields.slice(1) : fields;
  if (parts.length === 5) {
    const [minute, hour, dom, month, dow] = parts;
    const plainTime = /^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour);
    if (plainTime && dom === "*" && month === "*") {
      const time = fmtTime(Number(hour), Number(minute));
      if (dow === "*") return `Every day at ${time}${tzSuffix}`;
      if (/^[0-6](,[0-6])*$/.test(dow)) {
        const days = dow
          .split(",")
          .map((value) => weekdayLabel(value))
          .join(", ");
        return `Every ${days} at ${time}${tzSuffix}`;
      }
    }
  }
  return `Cron ${schedule}${tzSuffix}`;
};

// The scheduler defaults unnamed config entries to cron-<index+1>; the UI
// shows the same identity so a hand-edited entry is recognizable.
const withResolvedNames = (jobs: readonly CronJobConfig[]): NamedCronJob[] =>
  jobs.map((job, index) => ({
    ...job,
    name: job.name?.trim() || `cron-${index + 1}`,
  }));

export type { ScheduleBuild, ScheduleSelection };
export {
  buildSchedule,
  detectScheduleSelection,
  fmtDateTime,
  formatOneShotLocal,
  humanizeSchedule,
  nextFireTimes,
  parseOneShotSchedule,
  readScheduleSelection,
  SELECTION_DEFAULTS,
  validateCronPattern,
  WEEKDAYS,
  weekdayLabel,
  withResolvedNames,
};
