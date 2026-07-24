const UI_TITLE_SUFFIX = " \u2014 Goose Log Viewer";
const UI_HOME_TITLE = "Goose Log Viewer";
const UI_NEAR_BOTTOM_PX = 160;
const UI_MAX_TEXTAREA_HEIGHT = 240;
const UI_COPIED_MS = 1500;
const UI_THEME_KEY = "glv-theme";

const uiCopyIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const uiCheckIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const uiDownIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>';

// htmx swaps only the detail pane, so the server-set <title> grows stale;
// re-derive it from the rendered heading on every swap.
const uiSyncTitle = (): void => {
  for (const selector of [
    ".session-title",
    ".new-session h2",
    ".placeholder h2",
  ]) {
    const heading = document.querySelector(selector)?.textContent?.trim();
    if (heading) {
      document.title = `${heading}${UI_TITLE_SUFFIX}`;
      return;
    }
  }
  document.title = UI_HOME_TITLE;
};

const uiGrow = (el: HTMLTextAreaElement): void => {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, UI_MAX_TEXTAREA_HEIGHT)}px`;
};

const uiAutogrowAll = (): void => {
  for (const el of document.querySelectorAll<HTMLTextAreaElement>(
    "textarea.prompt-input",
  ))
    uiGrow(el);
};

// `autofocus` is ignored on elements inserted after first paint, so focus the
// new-session prompt ourselves when the form arrives via htmx.
const uiFocusAutofocus = (): void => {
  const el = document.querySelector<HTMLElement>("[autofocus]");
  if (el instanceof HTMLElement && document.activeElement !== el) el.focus();
};

const uiCopyWithFeedback = async (
  btn: HTMLElement,
  text: string,
  icons?: { active: string; idle: string },
): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard unavailable (non-secure context) — fail silently
    return;
  }
  btn.classList.add("copied");
  if (icons !== undefined) btn.innerHTML = icons.active;
  window.setTimeout(() => {
    btn.classList.remove("copied");
    if (icons !== undefined) btn.innerHTML = icons.idle;
  }, UI_COPIED_MS);
};

// Wrap a <pre> in a positioning container and append a copy button. Guarded by
// the wrapper class so re-runs from the MutationObserver are idempotent.
const uiEnhancePre = (pre: HTMLPreElement): void => {
  if (pre.parentElement?.classList.contains("code-block")) return;
  const wrap = document.createElement("div");
  wrap.className = "code-block";
  pre.parentNode?.insertBefore(wrap, pre);
  wrap.appendChild(pre);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-code-btn";
  btn.title = "Copy code";
  btn.setAttribute("aria-label", "Copy code");
  btn.innerHTML = uiCopyIcon;
  wrap.appendChild(btn);
};

const uiEnhanceCodeBlocks = (root: ParentNode): void => {
  for (const pre of root.querySelectorAll<HTMLPreElement>("pre"))
    uiEnhancePre(pre);
};

// Document-level delegation covers server-rendered buttons, htmx swaps, and
// SSE-appended stream lines without per-button listeners.
document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest(".copy-code-btn, .copy-md-btn");
  if (!(btn instanceof HTMLElement)) return;
  e.preventDefault();
  if (btn.classList.contains("copy-code-btn")) {
    const wrap = btn.closest(".code-block");
    const code = wrap?.querySelector("code") ?? wrap?.querySelector("pre");
    if (code === null || code === undefined) return;
    void uiCopyWithFeedback(btn, code.textContent ?? "", {
      active: uiCheckIcon,
      idle: uiCopyIcon,
    });
    return;
  }
  const md = btn.dataset.md;
  if (md !== undefined) void uiCopyWithFeedback(btn, md);
});

document.addEventListener("input", (e) => {
  if (
    e.target instanceof HTMLTextAreaElement &&
    e.target.classList.contains("prompt-input")
  )
    uiGrow(e.target);
});

// Persists the toggle; Layout.tsx applies the saved theme before first paint.
const uiApplyTheme = (isDark: boolean): void => {
  document.documentElement.classList.toggle("dark", isDark);
  try {
    localStorage.setItem(UI_THEME_KEY, isDark ? "dark" : "light");
  } catch {
    /* localStorage unavailable (e.g. private mode) — session only */
  }
};

const uiToggleTheme = (): void => {
  uiApplyTheme(!document.documentElement.classList.contains("dark"));
};

const uiApplyPane = (pane: string): void => {
  const app = document.querySelector(".app");
  if (app === null) return;
  app.setAttribute("data-mobile-pane", pane);
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    ".mobile-pane-btn",
  ))
    btn.setAttribute(
      "aria-pressed",
      btn.dataset.pane === pane ? "true" : "false",
    );
};

const uiInitPaneToggle = (): void => {
  const bar = document.querySelector(".mobile-pane-toggle");
  if (bar === null) return;
  const current =
    document.querySelector(".app")?.getAttribute("data-mobile-pane") ??
    "detail";
  uiApplyPane(current);
  bar.addEventListener("click", (e) => {
    const btn = (e.target as Element | null)?.closest(".mobile-pane-btn");
    if (!(btn instanceof HTMLElement)) return;
    const pane = btn.dataset.pane;
    if (pane !== undefined) uiApplyPane(pane);
  });
};

// Mounted on <body> (survives #detail-pane innerHTML swaps) since the button
// is position:fixed and lives outside the scroll container.
const uiEnsureScrollButton = (): void => {
  if (document.getElementById("scroll-latest") !== null) return;
  const pane = document.getElementById("detail-pane");
  if (pane === null) return;
  const btn = document.createElement("button");
  btn.id = "scroll-latest";
  btn.type = "button";
  btn.className = "scroll-latest";
  btn.hidden = true;
  btn.setAttribute("aria-label", "Scroll to latest");
  btn.title = "Scroll to latest";
  btn.innerHTML = uiDownIcon;
  btn.addEventListener("click", () => {
    const target = document.getElementById("detail-pane");
    target?.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
  });
  document.body.appendChild(btn);
  pane.addEventListener("scroll", uiUpdateScrollButton, { passive: true });
};

const uiUpdateScrollButton = (): void => {
  const pane = document.getElementById("detail-pane");
  const btn = document.getElementById("scroll-latest");
  if (pane === null || btn === null) return;
  const distance = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
  btn.hidden = distance < UI_NEAR_BOTTOM_PX;
};

// One rAF-coalesced pass reacts to every DOM change in the detail pane — htmx
// swaps, streamed lines, tail appends — without per-source wiring.
let uiScheduled = false;
const uiSchedule = (): void => {
  if (uiScheduled) return;
  uiScheduled = true;
  window.requestAnimationFrame(() => {
    uiScheduled = false;
    const pane = document.getElementById("detail-pane");
    if (pane !== null) uiEnhanceCodeBlocks(pane);
    uiUpdateScrollButton();
  });
};

const uiObserve = (): void => {
  const pane = document.getElementById("detail-pane");
  if (pane === null) return;
  new MutationObserver(() => uiSchedule()).observe(pane, {
    childList: true,
    subtree: true,
  });
};

const uiInit = (): void => {
  uiAutogrowAll();
  uiFocusAutofocus();
  uiEnsureScrollButton();
  uiEnhanceCodeBlocks(document.body);
  uiUpdateScrollButton();
  uiObserve();
  uiInitPaneToggle();
  document
    .querySelector(".theme-toggle")
    ?.addEventListener("click", uiToggleTheme);
};

document.addEventListener("DOMContentLoaded", uiInit);
// htmx swaps replace #detail-pane's children; re-sync title and focus — the
// MutationObserver picks up the new nodes for code-block enhancement.
document.body.addEventListener("htmx:afterSwap", (e) => {
  const target = (e as Event & { detail?: { target?: HTMLElement | null } })
    .detail?.target;
  if (target?.id !== "detail-pane") return;
  uiSyncTitle();
  uiAutogrowAll();
  uiFocusAutofocus();
  // Selecting a session swaps #detail-pane — surface it immediately.
  uiApplyPane("detail");
});
window.addEventListener("resize", uiUpdateScrollButton, { passive: true });
