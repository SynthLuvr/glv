const MENU_SELECTOR = ".session-menu";

// Session action sheet — the "⋯" control beside Archive in the transcript
// header. This script only toggles the server-rendered panel between
// closed and open (and closes it on Escape); presentation is pure CSS —
// a plain dropdown on desktop, a bottom sheet on mobile. Mirrors rename.ts:
// document-level delegation so out-of-band sidebar swaps never strand a
// handler. The destructive item carries no data-action at all, so its
// click flows straight to htmx (hx-confirm → hx-post) untouched.

const setOpen = (menu: Element, open: boolean): void => {
  menu.classList.toggle("is-open", open);
  const toggle = menu.querySelector<HTMLElement>(".session-menu-toggle");
  toggle?.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    // Standard menu behaviour: focus the first item when it opens.
    menu.querySelector<HTMLElement>(".session-menu-item")?.focus();
    return;
  }
  toggle?.focus();
};

const closeAllMenus = (): void => {
  for (const menu of document.querySelectorAll(`${MENU_SELECTOR}.is-open`))
    setOpen(menu, false);
};

const menuActions: Record<string, (menu: Element) => void> = {
  "toggle-session-menu": (menu) =>
    setOpen(menu, !menu.classList.contains("is-open")),
  "close-session-menu": (menu) => setOpen(menu, false),
};

document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  const btn = el?.closest("[data-action]");
  if (!(btn instanceof HTMLElement)) return;
  const action = menuActions[btn.dataset.action ?? ""];
  if (action === undefined) return;
  const menu = btn.closest(MENU_SELECTOR);
  if (menu === null) return;
  e.preventDefault();
  action(menu);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeAllMenus();
});

export {};
