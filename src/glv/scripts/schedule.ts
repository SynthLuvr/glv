import { parseSchedule } from "../schedule.js";

// Live validation for the typed schedule (with its optional timezone
// override). The form's Schedule Run button stays disabled until the
// schedule parses — the exact same parse the server runs on submit
// (schedule.ts is bundled here), so what the user sees before clicking
// is what the server will accept.

const SYNC_INPUT = "input[data-schedule-input]";
// The optional timezone override, sibling of the schedule field.
const TIMEZONE_FIELD = "input[data-schedule-timezone]";

const IDLE_HINT = "Validated as you type — plain English or cron.";

// The first upcoming run, formatted in the user's locale for instant
// confirmation; the server-side preview stays authoritative.
const firstRunText = (date: Date, timezone?: string): string =>
  date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(timezone === undefined ? {} : { timeZone: timezone }),
  });

// The timezone override sitting beside a schedule field, when one is
// filled in — empty means the server's own clock.
const timezoneOf = (form: HTMLFormElement | null): string | undefined => {
  const field = form?.querySelector<HTMLInputElement>(TIMEZONE_FIELD);
  const value = field?.value.trim();
  return value === undefined || value === "" ? undefined : value;
};

const syncField = (field: HTMLInputElement): void => {
  const form = field.closest("form");
  const slot =
    form?.querySelector<HTMLElement>("[data-schedule-validation]") ?? null;
  const submit =
    form?.querySelector<HTMLButtonElement>("[data-schedule-submit]") ??
    undefined;
  const setSlot = (text: string, state: "" | "ok" | "err"): void => {
    if (slot === null) return;
    slot.textContent = text;
    slot.dataset.state = state;
  };

  const value = field.value.trim();
  const timezone = timezoneOf(form);
  const disable = (text: string, state: "" | "ok" | "err"): void => {
    setSlot(text, state);
    if (submit !== undefined) submit.disabled = true;
  };
  if (value === "") return disable(IDLE_HINT, "");
  const parsed = parseSchedule(value, { timezone });
  if (!parsed.ok) return disable(parsed.error, "err");
  const first = parsed.info.next[0];
  const withCron =
    parsed.info.cron === undefined
      ? parsed.info.human
      : `${parsed.info.human} → ${parsed.info.cron}`;
  setSlot(
    first === undefined
      ? `✓ ${withCron}`
      : `✓ ${withCron} — first run ${firstRunText(first, timezone)}`,
    "ok",
  );
  if (submit !== undefined) submit.disabled = false;
};

const validateAll = (): void => {
  for (const field of document.querySelectorAll<HTMLInputElement>(SYNC_INPUT))
    syncField(field);
};

// Delegated, so htmx swaps (a rejected submit's re-render, an edit form)
// need no wiring beyond a re-sync. The timezone field re-validates its
// form's schedule — the two parse together.
document.addEventListener("input", (e) => {
  if (!(e.target instanceof Element)) return;
  if (e.target instanceof HTMLInputElement && e.target.matches(SYNC_INPUT))
    syncField(e.target);
  if (e.target instanceof HTMLInputElement && e.target.matches(TIMEZONE_FIELD))
    e.target
      .closest("form")
      ?.querySelectorAll<HTMLInputElement>(SYNC_INPUT)
      .forEach(syncField);
});

document.addEventListener("DOMContentLoaded", validateAll);

// Cancel closes the inline form the way the Saved prompts save form does:
// client-side, no round trip.
const closeSlot = (): void => {
  const slot = document.getElementById("cron-save-slot");
  if (slot !== null) slot.innerHTML = "";
};

document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const trigger = e.target.closest<HTMLElement>("[data-action]");
  if (trigger?.dataset.action === "close-schedule-slot") closeSlot();
});

const afterSwap = (e: Event): void => {
  const target = (e as Event & { detail?: { target?: HTMLElement | null } })
    .detail?.target;
  if (target === null || target === undefined) return;
  if (
    target.id === "detail-pane" ||
    target.querySelector?.(SYNC_INPUT) !== null
  )
    validateAll();
};
document.body.addEventListener("htmx:afterSwap", afterSwap);
