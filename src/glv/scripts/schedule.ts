import { parseSchedule } from "../schedule.js";

// Live validation for the typed schedule. The form's Schedule Run button
// stays disabled until the schedule parses — the exact same parse the
// server runs on submit (schedule.ts is bundled here), so what the user
// sees before clicking is what the server will accept.

const SYNC_INPUT = "input[data-schedule-input]";

// The save form's working directory starts as the New Session form's and
// keeps following it until the schedule form's own field is edited (or a
// rejected submit restores a typed one) — the form above stays a
// default, never a constraint.
const DIR_FIELD = "input[data-schedule-dir]";
const SESSION_DIR_FIELD = "form.new-session-form input[name=working_dir]";

let dirTouched = false;

const sessionDirField = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>(SESSION_DIR_FIELD);

const syncDirFromSession = (): void => {
  if (dirTouched) return;
  const field = document.querySelector<HTMLInputElement>(DIR_FIELD);
  const source = sessionDirField();
  if (field === null || source === null) return;
  field.value = source.value;
};

// Runs whenever the save form lands: a fresh form mirrors the form
// above, while a rejected submit's restored value counts as an edit and
// is left alone.
const seedDirField = (root: HTMLElement): void => {
  const field = root.querySelector<HTMLInputElement>(DIR_FIELD);
  if (field === null) return;
  dirTouched = field.value !== "";
  syncDirFromSession();
};

const IDLE_HINT = "Validated as you type — plain English or cron.";

// The first upcoming run, formatted in the user's locale for instant
// confirmation; the server-side preview stays authoritative.
const firstRunText = (date: Date): string =>
  date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

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
  const disable = (text: string, state: "" | "ok" | "err"): void => {
    setSlot(text, state);
    if (submit !== undefined) submit.disabled = true;
  };
  if (value === "") return disable(IDLE_HINT, "");
  const parsed = parseSchedule(value);
  if (!parsed.ok) return disable(parsed.error, "err");
  const first = parsed.info.next[0];
  const withCron =
    parsed.info.cron === undefined
      ? parsed.info.human
      : `${parsed.info.human} → ${parsed.info.cron}`;
  setSlot(
    first === undefined
      ? `✓ ${withCron}`
      : `✓ ${withCron} — first run ${firstRunText(first)}`,
    "ok",
  );
  if (submit !== undefined) submit.disabled = false;
};

const validateAll = (): void => {
  for (const field of document.querySelectorAll<HTMLInputElement>(SYNC_INPUT))
    syncField(field);
};

// Delegated, so htmx swaps (a rejected submit's re-render, an edit form)
// need no wiring beyond a re-sync.
document.addEventListener("input", (e) => {
  if (!(e.target instanceof Element)) return;
  if (e.target instanceof HTMLInputElement && e.target.matches(SYNC_INPUT))
    syncField(e.target);
  // Typing above re-syncs an untouched field; typing in the field itself
  // detaches it from the form above for good.
  if (e.target.matches(SESSION_DIR_FIELD)) syncDirFromSession();
  if (e.target.matches(DIR_FIELD)) dirTouched = true;
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
  if (target.querySelector?.(DIR_FIELD) !== null) seedDirField(target);
};
document.body.addEventListener("htmx:afterSwap", afterSwap);
