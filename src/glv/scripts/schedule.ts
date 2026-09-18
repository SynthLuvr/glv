import { AutoCompleteEvent } from "@github/auto-complete-element";
import { MAX_CRON_STEPS, parseSchedule } from "../schedule.js";
import { getHtmx, htmxSwapTarget } from "./htmx.js";

// Live validation for the typed schedule (with its optional timezone
// override). The form's Schedule Run button stays disabled until the
// schedule parses — the exact same parse the server runs on submit
// (schedule.ts is bundled here), so what the user sees before clicking
// is what the server will accept.

// The bare import registers <auto-complete>, the timezone field's
// type-to-search combobox; the element upgrades itself whenever it
// connects (htmx swaps included), so it needs no further wiring.

const SYNC_INPUT = "input[data-schedule-input]";
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

// Every schedule field in a form re-syncs together — a timezone edit
// re-validates the schedule beside it, since the two parse as one.
const syncFormSchedule = (field: HTMLInputElement): void => {
  field
    .closest("form")
    ?.querySelectorAll<HTMLInputElement>(SYNC_INPUT)
    .forEach(syncField);
};

// Delegated, so htmx swaps (a rejected submit's re-render, an edit form)
// need no wiring beyond a re-sync.
document.addEventListener("input", (e) => {
  if (!(e.target instanceof HTMLInputElement)) return;
  if (e.target.matches(SYNC_INPUT)) syncField(e.target);
  if (e.target.matches(TIMEZONE_FIELD)) syncFormSchedule(e.target);
});

document.addEventListener("DOMContentLoaded", validateAll);

// A combobox pick lands in the input programmatically — no input event
// fires, so the schedule's live verdict and the Next-runs preview would
// both sit stale until the next keystroke. Re-validate directly and
// request the preview exactly as the typing trigger would. (Not a
// synthetic input event: htmx's `changed` gate swallows events whose
// target's value didn't move, and one fired on the field would make
// the combobox re-open its popup for the just-picked zone.)
document.addEventListener("auto-complete-change", (e) => {
  // The combobox dispatches its own event subclass carrying the field as
  // relatedTarget; instanceof both narrows the event and re-proves the
  // element type at runtime.
  if (!(e instanceof AutoCompleteEvent)) return;
  const input = e.relatedTarget;
  if (!(input instanceof HTMLInputElement) || !input.matches(TIMEZONE_FIELD))
    return;
  syncFormSchedule(input);
  const api = getHtmx();
  const body = input
    .closest("[data-schedule-options]")
    ?.querySelector(".next-runs-body");
  if (api === undefined || body === null || body === undefined) return;
  const schedule =
    input.form?.querySelector<HTMLInputElement>(SYNC_INPUT)?.value ?? "";
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

// Follow-on steps (chained scheduled runs): adding or removing a step
// is pure DOM, and the listeners are delegated so an htmx swap (a
// rejected submit's re-render, a card restore) needs no re-wiring.

const STEPS_CONTAINER = "[data-cron-steps]";
const STEP_BLOCK = "[data-cron-step]";
const STEP_ADD = "[data-action=add-cron-step]";
const MAX_FOLLOW_UPS = MAX_CRON_STEPS - 1;

// Structurally identical to what the server renders
// (views/schedule.tsx FollowOnStep) so server-rendered and
// client-added blocks submit the same fields.
const STEP_BLOCK_HTML = `
<div class="cron-step" data-cron-step="">
  <label class="form-field">
    <span class="form-label">
      Then run — starts a new session after the one above finishes
    </span>
    <textarea name="follow_up" class="form-input" rows="3"></textarea>
  </label>
  <button
    type="button"
    class="cron-step-remove"
    data-action="remove-cron-step"
    aria-label="Remove this follow-on step"
  >×</button>
</div>`;

const newStepBlock = (): HTMLElement => {
  const template = document.createElement("template");
  template.innerHTML = STEP_BLOCK_HTML;
  const block = template.content.firstElementChild;
  // STEP_BLOCK_HTML is a constant whose root is a <div>; a miss here is
  // a programming error in that constant, not a runtime possibility.
  if (!(block instanceof HTMLElement))
    throw new Error("step block template did not yield an element");
  return block;
};

// The add button reflects the cap: disabled (with the reason as its
// title) once the form holds the most follow-ons a job may stack.
const syncStepAddButton = (container: Element): void => {
  const add = container.querySelector<HTMLButtonElement>(STEP_ADD);
  if (add === null) return;
  const atCap = container.querySelectorAll(STEP_BLOCK).length >= MAX_FOLLOW_UPS;
  add.disabled = atCap;
  add.title = atCap
    ? `At most ${MAX_FOLLOW_UPS} follow-on steps`
    : "Stack another prompt that runs after the one above finishes";
};

const addStep = (trigger: HTMLElement): void => {
  const container = trigger.closest(STEPS_CONTAINER);
  if (container === null) return;
  if (container.querySelectorAll(STEP_BLOCK).length >= MAX_FOLLOW_UPS) return;
  trigger.before(newStepBlock());
  syncStepAddButton(container);
};

const removeStep = (trigger: HTMLElement): void => {
  const container = trigger.closest(STEPS_CONTAINER);
  const step = trigger.closest(STEP_BLOCK);
  if (container === null || step === null) return;
  step.remove();
  syncStepAddButton(container);
};

const syncAllStepButtons = (): void => {
  for (const container of document.querySelectorAll(STEPS_CONTAINER))
    syncStepAddButton(container);
};

document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const trigger = e.target.closest<HTMLElement>("[data-action]");
  if (trigger === null) return;
  switch (trigger.dataset.action) {
    case "close-schedule-slot":
      closeSlot();
      break;
    case "add-cron-step":
      addStep(trigger);
      break;
    case "remove-cron-step":
      removeStep(trigger);
      break;
  }
});

const afterSwap = (e: Event): void => {
  const target = htmxSwapTarget(e);
  if (target === null) return;
  if (target.id === "detail-pane" || target.querySelector(SYNC_INPUT) !== null)
    validateAll();
  syncAllStepButtons();
};
document.body.addEventListener("htmx:afterSwap", afterSwap);
