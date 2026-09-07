const UI_TITLE_SUFFIX = " \u2014 GLV";
const UI_HOME_TITLE = "GLV";
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

// htmx 2's default `responseHandling` discards 4xx/5xx responses, but the
// server answers rejected submits with a 422 fragment (the form re-rendered
// with the typed work preserved plus an error banner) and unknown sessions
// with a 404 detail. Those must swap, or every form error fails silently:
// the user clicks and nothing happens. This file loads after htmx.min.js
// (defer order) and before any user request can fire.
declare const htmx: {
  config: {
    responseHandling: Array<{ code: string; swap: boolean; error?: boolean }>;
  };
};
if (typeof htmx !== "undefined")
  htmx.config.responseHandling = [
    { code: "204", swap: false },
    { code: "[23]..", swap: true },
    { code: "[45]..", swap: true, error: true },
  ];

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
  const btn = e.target.closest(".copy-code-btn, .copy-md-btn, .copy-value-btn");
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
  if (btn.classList.contains("copy-value-btn")) {
    const copyValue = btn.dataset.copy;
    if (copyValue !== undefined) void uiCopyWithFeedback(btn, copyValue);
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

const uiSyncThemeToggle = (isDark: boolean): void =>
  document
    .querySelector(".theme-toggle")
    ?.setAttribute("aria-pressed", String(isDark));

// Persists the toggle; Layout.tsx applies the saved theme before first paint.
const uiApplyTheme = (isDark: boolean): void => {
  document.documentElement.classList.toggle("dark", isDark);
  uiSyncThemeToggle(isDark);
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
  // Pane switches resize the detail pane (display:none while the sidebar
  // is active) without scrolling it or touching its DOM, so neither a
  // scroll event nor the mutation observer recomputes the scroll button:
  // a distance-0 reading taken while the pane was hidden would stick and
  // leave the button hidden for good. Recompute next frame, once the pane
  // is laid out.
  window.requestAnimationFrame(uiUpdateScrollButton);
};

// Bars already wired this page's lifetime. Tracked in JS memory, not a DOM
// attribute: htmx snapshots the live DOM for history restore, so a marker
// attribute would be replayed by the restore onto an unwired bar and the
// guard would then skip wiring the one node that needs it.
const uiWiredPaneBars = new WeakSet<Element>();
const uiInitPaneToggle = (): void => {
  const bar = document.querySelector(".mobile-pane-toggle");
  if (bar === null || uiWiredPaneBars.has(bar)) return;
  uiWiredPaneBars.add(bar);
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
// is position:fixed and lives outside the scroll container. The scroll
// listener follows the pane element: a history restore replaces the pane
// (detaching the old binding) while the body-mounted button survives.
let uiScrollPane: Element | undefined;
const uiEnsureScrollButton = (): void => {
  const pane = document.getElementById("detail-pane");
  if (pane === null) return;
  if (uiScrollPane !== pane) {
    uiScrollPane?.removeEventListener("scroll", uiUpdateScrollButton);
    uiScrollPane = pane;
    pane.addEventListener("scroll", uiUpdateScrollButton, { passive: true });
  }
  if (document.getElementById("scroll-latest") !== null) return;
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
};

const uiUpdateScrollButton = (): void => {
  const pane = document.getElementById("detail-pane");
  const btn = document.getElementById("scroll-latest");
  if (pane === null || btn === null) return;
  const distance = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
  btn.hidden = distance < UI_NEAR_BOTTOM_PX;
};

// One rAF-coalesced pass reacts to every DOM change in the detail pane — htmx
// swaps, streamed lines, tail appends — without per-source wiring. The
// observer is tracked so a history restore (which replaces the pane) can
// re-observe the fresh node instead of stacking observers on dead ones.
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

let uiObserver: MutationObserver | undefined;
const uiObserve = (): void => {
  uiObserver?.disconnect();
  const pane = document.getElementById("detail-pane");
  if (pane === null) return;
  uiObserver = new MutationObserver(() => uiSchedule());
  uiObserver.observe(pane, {
    childList: true,
    subtree: true,
  });
};

// Shows the source body matching the selected radio and hides the rest. The
// bodies are server-rendered (both present); this just toggles `hidden`.
const uiSyncSourceBodies = (): void => {
  const container = document.querySelector("[data-source-bodies]");
  if (container === null) return;
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="session_mode"]:checked',
  );
  const active = checked?.value ?? "working_dir";
  for (const body of container.querySelectorAll<HTMLElement>(
    "[data-source-body]",
  ))
    body.hidden = body.dataset.sourceBody !== active;
};

const uiInitSourceToggle = (): void => {
  const toggle = document.querySelector(".source-toggle");
  if (toggle === null) return;
  uiSyncSourceBodies();
  toggle.addEventListener("change", (e) => {
    if (
      e.target instanceof HTMLInputElement &&
      e.target.name === "session_mode"
    )
      uiSyncSourceBodies();
  });
};

// Toggles wired this page's lifetime (WeakSet, not a DOM marker — history
// restore replays snapshot attributes onto unwired replacement nodes).
const uiWiredThemeToggles = new WeakSet<Element>();
const uiInitThemeToggle = (): void => {
  const themeToggle = document.querySelector(".theme-toggle");
  if (
    themeToggle instanceof HTMLElement &&
    !uiWiredThemeToggles.has(themeToggle)
  ) {
    uiWiredThemeToggles.add(themeToggle);
    themeToggle.addEventListener("click", uiToggleTheme);
  }
};

const uiInit = (): void => {
  uiAutogrowAll();
  uiFocusAutofocus();
  uiEnsureScrollButton();
  uiEnhanceCodeBlocks(document.body);
  uiUpdateScrollButton();
  uiObserve();
  uiInitPaneToggle();
  uiInitSourceToggle();
  // Reflect the pre-paint theme class (set by Layout's bootstrap script) on
  // the toggle for assistive tech.
  uiSyncThemeToggle(document.documentElement.classList.contains("dark"));
  uiInitThemeToggle();
};

document.addEventListener("DOMContentLoaded", uiInit);
// htmx swaps replace #detail-pane's children; re-sync title and focus — the
// MutationObserver picks up the new nodes for code-block enhancement. The
// mobile pane switch is deliberately NOT done here: a swap that lands after
// the user clicked "Sessions" would bounce them back to the detail pane.
document.body.addEventListener("htmx:afterSwap", (e) => {
  const target = (e as Event & { detail?: { target?: HTMLElement | null } })
    .detail?.target;
  if (target?.id !== "detail-pane") return;
  uiSyncTitle();
  uiAutogrowAll();
  uiFocusAutofocus();
  uiInitSourceToggle();
});
// Surface the detail pane at click time — not when the swap lands — so a
// slow response can never override a user who switched to the session list.
document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const link = e.target.closest("[hx-get]");
  if (link !== null && link.closest('[hx-target="#detail-pane"]') !== null)
    uiApplyPane("detail");
});
window.addEventListener("resize", uiUpdateScrollButton, { passive: true });

// Only transcript URLs render with the detail pane surfaced on mobile (the
// server sets `data-mobile-pane` from the selected session); the new-session
// form, model picker, and sidebar-meta endpoints all start on the sidebar.
const UI_SESSION_PATH = /^\/sessions\/[^/]+$/;
const UI_LIST_SESSION_PATHS = new Set([
  "/sessions/new",
  "/sessions/model-picker",
  "/sessions/sidebar-meta",
]);
const uiPaneForPath = (path: string): string => {
  if (UI_LIST_SESSION_PATHS.has(path)) return "sidebar";
  return UI_SESSION_PATH.test(path) ? "detail" : "sidebar";
};

// htmx history restoration (Back/Forward) swaps the whole body: every
// listener wired onto page elements at DOMContentLoaded — the Sessions/
// Detail pane toggle, the theme toggle, the detail-pane scroll and observer
// bindings — dies with the old nodes, leaving the tabs dead until reload.
// The restored snapshot also replays whatever pane was frozen at push time
// (entering a session flips to "detail" before the save), so going Back to
// the list can land buried in the detail pane. Re-derive the pane from the
// restored URL — the same rule a full page load applies — and re-run the
// init against the fresh DOM; every step is idempotent. The swap itself is
// synchronous (swapDelay 0), so the new nodes are in place here.
const uiOnHistoryRestore = (): void => {
  document
    .querySelector(".app")
    ?.setAttribute("data-mobile-pane", uiPaneForPath(window.location.pathname));
  uiSyncTitle();
  uiInit();
};
document.body.addEventListener("htmx:historyRestore", uiOnHistoryRestore);

export {};
