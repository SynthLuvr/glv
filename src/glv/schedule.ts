import later, { type LaterSchedule } from "@breejs/later";
import { Cron } from "croner";
import type { CronJobConfig } from "./config.js";
import { errorMessage } from "./util.js";

// Everything a schedule can be, parsed once and shared by every consumer
// (the form's live validation, the preview, the cards, and the
// scheduler). A schedule is one of:
//
//   - an ISO 8601 local datetime ("2026-09-03T09:00") — fires once
//   - a cron pattern ("0 9 * * 1-5") — croner, optional timezone
//   - human text ("every weekday at 9:00") — parsed by @breejs/later
//
// Text schedules are always in the server's local timezone (cron
// patterns keep a job's timezone override); later is switched to local
// time here, once, before anything parses or enumerates.
later.date.localTime();

type ScheduleKind = "once" | "cron" | "text";

type ScheduleInfo = {
  readonly kind: ScheduleKind;
  /** Plain-language rendering for cards and confirmations. */
  readonly human: string;
  /**
   * The cron pattern an English schedule translated to (text kind only).
   * English is never stored or fired directly — it becomes cron at save
   * time, so the config file keeps one canonical schedule spelling.
   */
  readonly cron?: string;
  /** The next fire times, soonest first (empty when it never fires). */
  readonly next: readonly Date[];
};

type ScheduleParse =
  | { readonly ok: true; readonly info: ScheduleInfo }
  | { readonly ok: false; readonly error: string };

// ISO-local datetimes (what the form writes) plus full ISO with a zone
// (what Date#toISOString writes) — both are fire-once inputs.
const ONE_SHOT_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

const twoDigits = (n: number): string => String(n).padStart(2, "0");

// The one-shot spelling the form produces: local ISO to minute
// precision.
const formatOneShotLocal = (date: Date): string =>
  `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(
    date.getDate(),
  )}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;

// Returns the instant a fire-once schedule targets, or undefined for
// cron patterns, human text (and malformed values). Zone-less spellings
// roll impossible dates over silently (Feb 30 → Mar 2), so they must
// round-trip to count as valid.
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
  if (
    !/(Z|[+-]\d{2}:?\d{2})$/.test(schedule) &&
    formatOneShotLocal(date) !== schedule
  )
    return undefined;

  return date;
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

const friendlyCronError = (detail: string): string =>
  `That doesn’t look like a cron pattern — try something like "0 9 * * 1-5" ` +
  `(at 09:00 on weekdays). Details: ${detail}`;

// Validates a cron pattern exactly the way serve will (by constructing
// croner's Cron), wrapping the technical message in plain language.
const buildCron = (
  pattern: string,
  timezone: string | undefined,
): { ok: true; cron: Cron } | { ok: false; error: string } => {
  const fields = pattern.split(/\s+/);
  // @nicknames (@daily, …) are single-token croner patterns; plain
  // patterns are 5-7 fields.
  if (!pattern.startsWith("@") && (fields.length < 5 || fields.length > 7))
    return {
      ok: false,
      error: friendlyCronError(
        `expected 5 to 7 space-separated fields, got ${fields.length}`,
      ),
    };
  try {
    return { ok: true, cron: new Cron(pattern, { timezone }) };
  } catch (err) {
    return {
      ok: false,
      error: friendlyCronError(
        errorMessage(err).replace(/^CronPattern:\s*/, ""),
      ),
    };
  }
};

// Cron-shaped means: a @nickname, or 5-7 whitespace tokens whose first
// starts with a digit or * — anything else is offered to the human-text
// parser. (Human text never starts with a digit, * or @.)
const cronShaped = (schedule: string): boolean => {
  if (schedule.startsWith("@")) return true;
  const fields = schedule.split(/\s+/);
  return (
    fields.length >= 5 &&
    fields.length <= 7 &&
    /^[*\d]/.test(schedule) &&
    /^[\d*,/\-?LW#A-Za-z]+$/.test(fields[0])
  );
};

// The minimum gap between two fires. Text schedules without a time
// ("every weekday") match every second — an agent storm — so they are
// rejected up front instead of ever being scheduled.
const MIN_FIRE_GAP_MS = 60_000;

const TEXT_HELP =
  `Try “every weekday at 9:00”, “at 9:00”, ` +
  `“on sunday at 18:00”, or a cron pattern like “0 9 * * 1-5”.`;

const TOO_INTRICATE =
  "That schedule is too intricate to turn into cron — try " +
  `“every weekday at 9:00”, “every 30 minutes”, or write the cron ` +
  "pattern yourself.";

// A list of cron field values compressed for readability: even steps
// from zero over the full cycle become "*/n", consecutive runs become
// "a-b", anything else a plain list.
const compressField = (
  values: readonly number[],
  stepCycle: number | undefined,
): string => {
  const list = [...new Set(values)].sort((a, b) => a - b);
  if (list.length === 1) return String(list[0]);
  if (stepCycle !== undefined) {
    const step = list[1] - list[0];
    const spansCycle =
      list.every((value, index) => value === index * step) &&
      list[list.length - 1] + step === stepCycle;
    if (spansCycle && step > 1) return `*/${step}`;
  }
  const parts: string[] = [];
  let start = list[0];
  let prev = list[0];
  for (const value of [...list.slice(1), undefined]) {
    if (value !== prev + 1) {
      parts.push(start === prev ? `${start}` : `${start}-${prev}`);
      if (value !== undefined) start = value;
    }
    if (value !== undefined) prev = value;
  }
  return parts.join(",");
};

// Translates one of later's parsed text schedules into an equivalent
// cron pattern. later's day-of-week is 1=Sunday..7=Saturday (cron is
// 0=Sunday), and day-of-month 0 means "the last day" (cron "L"). Only
// the plain shapes the documented vocabulary produces are translated;
// anything else is rejected as too intricate rather than mistranslated.
const translateToCron = (parsed: LaterSchedule): string | undefined => {
  if (parsed.schedules.length !== 1 || parsed.exceptions.length > 0)
    return undefined;
  const sched = parsed.schedules[0];
  const known = ["t", "m", "h", "D", "d", "M", "s"];
  if (Object.keys(sched).some((key) => !known.includes(key))) return undefined;
  if (sched.s !== undefined && !(sched.s.length === 1 && sched.s[0] === 0))
    return undefined;

  let minute: string;
  let hour: string;
  if (sched.t !== undefined) {
    if (sched.t.length !== 1) return undefined;
    const t = sched.t[0];
    if (!Number.isFinite(t) || t < 0 || t % 60 !== 0) return undefined;
    if (sched.m !== undefined || sched.h !== undefined) return undefined;
    hour = String(Math.floor(t / 3600));
    minute = String((t % 3600) / 60);
  } else if (sched.m !== undefined && sched.h !== undefined) {
    minute = compressField(sched.m, 60);
    hour = compressField(sched.h, 24);
  } else if (sched.m !== undefined) {
    minute = compressField(sched.m, 60);
    hour = "*";
  } else if (sched.h !== undefined) {
    minute = "0";
    hour = compressField(sched.h, 24);
  } else {
    // No time anchor at all ("every weekday") — refuse rather than
    // inventing one.
    return undefined;
  }

  let dom = "*";
  if (sched.D !== undefined) {
    if (sched.D.includes(0))
      return sched.D.length === 1 ? `${minute} ${hour} L * *` : undefined;
    dom = compressField(sched.D, undefined);
  }
  const month = sched.M === undefined ? "*" : compressField(sched.M, undefined);
  const dow =
    sched.d === undefined
      ? "*"
      : compressField(
          sched.d.map((v) => (v === 0 ? 0 : (v + 6) % 7)),
          7,
        );
  return `${minute} ${hour} ${dom} ${month} ${dow}`;
};

// English in, cron out. The gap guard still runs first so sub-minute
// phrasings ("after 9:00am") get the specific message; everything else
// must translate.
const parseTextSchedule = (
  schedule: string,
  timezone: string | undefined,
): ScheduleParse => {
  const parsed = later.parse.text(schedule);
  if (parsed.error !== -1 || parsed.schedules.length === 0)
    return {
      ok: false,
      error: `Couldn’t understand that schedule — ${TEXT_HELP}`,
    };
  const runs = later.schedule(parsed).next(2);
  if (runs.length === 0)
    return { ok: false, error: `That schedule never fires — ${TEXT_HELP}` };
  if (
    runs.length > 1 &&
    runs[1].getTime() - runs[0].getTime() < MIN_FIRE_GAP_MS
  )
    return {
      ok: false,
      error:
        "That fires more often than once a minute — give it a time, " +
        `like “every weekday at 9:00”.`,
    };
  const cron = translateToCron(parsed);
  if (cron === undefined) {
    // Distinguish the common miss (no time at all, e.g. "every
    // weekday") from genuinely untranslatable shapes.
    const sched = parsed.schedules[0];
    const hasTime =
      sched.t !== undefined || sched.m !== undefined || sched.h !== undefined;
    return hasTime
      ? { ok: false, error: TOO_INTRICATE }
      : {
          ok: false,
          error:
            "Give the schedule a time, like “every weekday at 9:00” — " +
            "bare “every weekday” has no moment to fire at.",
        };
  }
  const built = buildCron(cron, timezone);
  if (!built.ok) return { ok: false, error: TOO_INTRICATE };
  return {
    ok: true,
    info: {
      kind: "text",
      human: schedule,
      cron,
      next: built.cron.nextRuns(3),
    },
  };
};

// The one entry point: classifies and validates a raw schedule string,
// returning its human form and next fire times, or a plain-language
// error. The client bundles this exact function for as-you-type
// validation; the server re-runs it on submit and at boot.
const parseSchedule = (
  raw: string,
  opts: { timezone?: string } = {},
): ScheduleParse => {
  const schedule = raw.trim();
  if (schedule === "")
    return { ok: false, error: `Type a schedule — ${TEXT_HELP}` };

  const once = parseOneShotSchedule(schedule);
  if (once !== undefined) {
    if (once.getTime() <= Date.now())
      return {
        ok: false,
        error: "That time is already in the past — pick a future one.",
      };
    return {
      ok: true,
      info: {
        kind: "once",
        human: `Once at ${fmtDateTime(once)}`,
        next: [once],
      },
    };
  }

  if (cronShaped(schedule)) {
    const built = buildCron(schedule, opts.timezone);
    if (!built.ok) return built;
    return {
      ok: true,
      info: {
        kind: "cron",
        human: humanizeCron(schedule, opts.timezone),
        next: built.cron.nextRuns(3),
      },
    };
  }

  return parseTextSchedule(schedule, opts.timezone);
};

// Cron rendered plainly when it matches the shapes people mean
// ("0 9 * * *" → "Every day at 09:00"), the raw pattern otherwise.
const humanizeCron = (schedule: string, timezone?: string): string => {
  const tzSuffix = timezone === undefined ? "" : ` (${timezone})`;
  const fields = schedule.split(/\s+/);
  const parts =
    fields.length === 6 && fields[0] === "0" ? fields.slice(1) : fields;
  if (parts.length === 5) {
    const [minute, hour, dom, month, dow] = parts;
    const plainTime = /^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour);
    if (plainTime && dom === "*" && month === "*") {
      const time = `${twoDigits(Number(hour))}:${twoDigits(Number(minute))}`;
      if (dow === "*") return `Every day at ${time}${tzSuffix}`;
      const days = expandWeekdays(dow);
      if (days !== undefined) return `Every ${days} at ${time}${tzSuffix}`;
    }
  }
  return `Cron ${schedule}${tzSuffix}`;
};

// A cron day-of-week field of plain digits, ranges, and lists expanded
// into day names ("1-5" → "Mon, Tue, Wed, Thu, Fri"); undefined when the
// field uses anything fancier (steps, names, L/W/#).
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const expandWeekdays = (dow: string): string | undefined => {
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(dow)) return undefined;
  const days: string[] = [];
  for (const part of dow.split(",")) {
    const [first, last] = part.split("-").map(Number);
    const end = last ?? first;
    if (
      !Number.isInteger(first) ||
      first < 0 ||
      first > 6 ||
      !Number.isInteger(end) ||
      end < first ||
      end > 6
    )
      return undefined;
    for (let day = first; day <= end; day++) days.push(DAY_NAMES[day]);
  }
  return days.join(", ");
};

// Plain-language rendering of any stored schedule (text schedules are
// their own human form; broken ones fall back to the raw string).
const humanizeSchedule = (schedule: string, timezone?: string): string => {
  const parsed = parseSchedule(schedule, { timezone });
  return parsed.ok ? parsed.info.human : schedule;
};

// A job whose display name has been resolved (unnamed entries default
// to cron-<n>); what the UI renders and mutates.
type NamedCronJob = CronJobConfig & { readonly name: string };

// Unnamed config entries are identified by their position. The
// scheduler, the UI, and deletion all resolve names through this so a
// hand-edited entry keeps one identity everywhere.
const resolvedCronName = (job: CronJobConfig, index: number): string =>
  job.name?.trim() || `cron-${index + 1}`;

// The UI shows each config entry under the same resolved identity the
// scheduler uses, so a hand-edited entry is recognizable.
const withResolvedNames = (jobs: readonly CronJobConfig[]): NamedCronJob[] =>
  jobs.map((job, index) => ({ ...job, name: resolvedCronName(job, index) }));

export type { NamedCronJob };
export {
  fmtDateTime,
  formatOneShotLocal,
  humanizeSchedule,
  parseOneShotSchedule,
  parseSchedule,
  resolvedCronName,
  withResolvedNames,
};
