import { getHtmx } from "./htmx.js";

const closestWrap = (el: Element | null): Element | null =>
  el?.closest(".rename-wrap") ?? null;

const inputOf = (wrap: Element): HTMLInputElement | null =>
  wrap.querySelector<HTMLInputElement>(".rename-input");

const renameInput = (target: EventTarget | null): HTMLInputElement | null =>
  target instanceof HTMLInputElement &&
  target.classList.contains("rename-input")
    ? target
    : null;

const enterEdit = (wrap: Element): void => {
  wrap.classList.add("is-editing");
  const input = inputOf(wrap);
  if (input !== null) {
    input.focus();
    input.select();
  }
};

const exitEdit = (wrap: Element): void => {
  wrap.classList.remove("is-editing");
  const input = inputOf(wrap);
  if (input !== null) input.value = input.dataset.originalName ?? "";
};

const editActions: Record<string, (wrap: Element) => void> = {
  rename: enterEdit,
  "cancel-rename": exitEdit,
};

// The form has no action, so requestSubmit() can fall back to a native POST to
// the current URL (a 404); trigger htmx directly so the rename stays in place.
const submitRename = (form: HTMLFormElement | null): void => {
  if (form === null) return;
  const htmx = getHtmx();
  if (htmx !== undefined) {
    htmx.trigger(form, "submit");
    return;
  }
  form.requestSubmit();
};

// Document-level delegation survives the out-of-band sidebar swaps that
// renaming (and archiving) trigger, mirroring sidebar.ts.
document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  const btn = el?.closest("[data-action]");
  if (!(btn instanceof HTMLElement)) return;
  const apply = editActions[btn.dataset.action ?? ""];
  if (apply === undefined) return;
  e.preventDefault();
  const wrap = closestWrap(btn);
  if (wrap !== null) apply(wrap);
});

document.addEventListener("keydown", (e) => {
  const input = renameInput(e.target);
  if (input === null) return;
  const wrap = closestWrap(input);
  if (wrap === null) return;
  if (e.key === "Enter") {
    e.preventDefault();
    submitRename(input.form);
  } else if (e.key === "Escape") {
    e.preventDefault();
    exitEdit(wrap);
    input.blur();
  }
});

// Blur-to-save: submit when focus leaves the input, unless it moves to a
// sibling confirm/cancel button inside the same wrap (those act on click).
document.addEventListener("focusout", (e) => {
  const input = renameInput(e.target);
  if (input === null) return;
  const wrap = closestWrap(input);
  if (wrap === null) return;
  const movedTo = e.relatedTarget;
  if (movedTo instanceof Element && wrap.contains(movedTo)) return;
  if (input.value === (input.dataset.originalName ?? "")) {
    exitEdit(wrap);
    return;
  }
  submitRename(input.form);
});
