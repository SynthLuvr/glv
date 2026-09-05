import { parseSchedule } from "../schedule.js";

// Live validation for the typed schedule (with its optional timezone
// override). The form's Schedule Run button stays disabled until the
// schedule parses — the exact same parse the server runs on submit
// (schedule.ts is bundled here), so what the user sees before clicking
// is what the server will accept.

// Registers <auto-complete>: the timezone field's type-to-search
// combobox. The element upgrades itself whenever it connects (htmx
// swaps included), so a bare import is all the wiring it needs.
import "@github/auto-complete-element";

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
const timezoneOf = (form: HTMLFormElement | null): string | undefined =>
  form?.querySelector<HTMLInputElement>(TIMEZONE_FIELD)?.value.trim() ||
  undefined;

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

// The htmx surface this file needs beyond attribute wiring: a direct
// preview request after a combobox pick (below). groups.ts drives its
// swaps the same way.
type HtmxApi = {
  ajax: (
    verb: string,
    path: string,
    options: {
      target: Element;
      swap: string;
      values: Record<string, string>;
    },
  ) => void;
};

const globalHtmx = (): HtmxApi | undefined => {
  const { htmx } = globalThis as { htmx?: unknown };
  if (typeof htmx !== "object" || htmx === null) return undefined;
  return "ajax" in htmx && typeof htmx.ajax === "function"
    ? (htmx as HtmxApi)
    : undefined;
};

// A combobox pick lands in the input programmatically — no input event
// fires, so the schedule's live verdict and the Next-runs preview would
// both sit stale until the next keystroke. Re-validate directly and
// request the preview exactly as the typing trigger would. (Not a
// synthetic input event: htmx's `changed` gate swallows events whose
// target's value didn't move, and one fired on the field would make
// the combobox re-open its popup for the just-picked zone.)
document.addEventListener("auto-complete-change", (e) => {
  const input = (e as Event & { relatedTarget?: EventTarget | null })
    .relatedTarget;
  if (!(input instanceof HTMLInputElement) || !input.matches(TIMEZONE_FIELD))
    return;
  const form = input.closest("form");
  form?.querySelectorAll<HTMLInputElement>(SYNC_INPUT).forEach(syncField);
  const api = globalHtmx();
  const body = input
    .closest("[data-schedule-options]")
    ?.querySelector(".next-runs-body");
  if (api === undefined || body === null || body === undefined) return;
  const schedule =
    form?.querySelector<HTMLInputElement>(SYNC_INPUT)?.value ?? "";
  api.ajax("GET", "/cron/preview", {
    target: body,
    swap: "innerHTML",
    values: { schedule, timezone: input.value },
  });
});

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
