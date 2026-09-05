const setOpen = (menu: Element, open: boolean): void => {
  menu.classList.toggle("is-open", open);
  const toggle = menu.querySelector<HTMLElement>(".session-menu-toggle");
  toggle?.setAttribute("aria-expanded", String(open));
  if (open) {
    // Standard menu behaviour: focus the first item when it opens.
    menu.querySelector<HTMLElement>(".session-menu-item")?.focus();
    return;
  }
  toggle?.focus();
};

const menuActions: Record<string, (menu: Element) => void> = {
  "toggle-session-menu": (menu) =>
    setOpen(menu, !menu.classList.contains("is-open")),
  "close-session-menu": (menu) => setOpen(menu, false),
};

// Session action sheet (the "⋯" control beside Archive): this script only
// toggles the server-rendered panel between closed and open; presentation
// is pure CSS — a dropdown on desktop, a bottom sheet on mobile.
// Document-level delegation (like rename.ts) survives the out-of-band
// sidebar swaps; the delete item carries no data-action, so its click
// flows straight to htmx (hx-confirm → hx-post) untouched.
document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  const btn = el?.closest("[data-action]");
  if (!(btn instanceof HTMLElement)) return;
  const action = menuActions[btn.dataset.action ?? ""];
  if (action === undefined) return;
  const menu = btn.closest(".session-menu");
  if (menu === null) return;
  e.preventDefault();
  action(menu);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const menu of document.querySelectorAll(".session-menu.is-open"))
    setOpen(menu, false);
});

export {};
