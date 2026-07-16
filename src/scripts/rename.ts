const closestWrap = (el: Element | null): Element | null =>
  el?.closest(".rename-wrap") ?? null;

const inputOf = (wrap: Element): HTMLInputElement | null =>
  wrap.querySelector<HTMLInputElement>(".rename-input");

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

// Event delegation on `document` survives the out-of-band sidebar swaps that
// renaming (and archiving) trigger, mirroring sidebar.ts.
document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  const editBtn = el?.closest('[data-action="rename"]');
  if (editBtn instanceof HTMLElement) {
    e.preventDefault();
    const wrap = closestWrap(editBtn);
    if (wrap !== null) enterEdit(wrap);
    return;
  }
  const cancelBtn = el?.closest('[data-action="cancel-rename"]');
  if (cancelBtn instanceof HTMLElement) {
    e.preventDefault();
    const wrap = closestWrap(cancelBtn);
    if (wrap !== null) exitEdit(wrap);
  }
});

document.addEventListener("keydown", (e) => {
  if (
    !(e.target instanceof HTMLInputElement) ||
    !e.target.classList.contains("rename-input")
  )
    return;
  const wrap = closestWrap(e.target);
  if (wrap === null) return;
  if (e.key === "Enter") {
    e.preventDefault();
    e.target.form?.requestSubmit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    exitEdit(wrap);
    e.target.blur();
  }
});

// blur-to-save: submit when focus leaves the control. Skip when focus moves to
// a sibling button (confirm/cancel) inside the same wrap — those act on click.
document.addEventListener("focusout", (e) => {
  const input = e.target;
  if (
    !(input instanceof HTMLInputElement) ||
    !input.classList.contains("rename-input")
  )
    return;
  const wrap = closestWrap(input);
  if (wrap === null) return;
  const related = e.relatedTarget;
  if (related instanceof Element && wrap.contains(related)) return;
  const original = input.dataset.originalName ?? "";
  if (input.value === original) {
    exitEdit(wrap);
    return;
  }
  input.form?.requestSubmit();
});
