import { parseJson } from "./shared";

const getChecks = (): HTMLInputElement[] => [
  ...document.querySelectorAll<HTMLInputElement>(".session-check"),
];

const updateBulkBar = (): void => {
  const checks = getChecks();
  const checkedCount = checks.filter((c) => c.checked).length;
  const allChecked = checks.length > 0 && checkedCount === checks.length;
  const count = document.getElementById("bulk-count");
  if (count) count.textContent = String(checkedCount);
  const bar = document.getElementById("bulk-bar");
  if (bar) bar.hidden = checkedCount === 0;
  const toggle = document.getElementById("bulk-toggle");
  if (toggle) {
    toggle.textContent = allChecked ? "Deselect all" : "Select all";
    toggle.setAttribute("aria-pressed", String(allChecked));
  }
};

// Event delegation on `document` survives the out-of-band sidebar swaps that
// archiving triggers. Navigation swaps only the detail pane, so an in-progress
// selection is preserved between page transitions.
document.addEventListener("change", (e) => {
  if (
    e.target instanceof HTMLInputElement &&
    e.target.classList.contains("session-check")
  )
    updateBulkBar();
});

document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;

  const btn = el?.closest("[data-bulk-action]");
  if (btn instanceof HTMLElement) {
    e.preventDefault();
    const checks = getChecks();
    if (btn.dataset.bulkAction === "select-all") {
      const allChecked = checks.length > 0 && checks.every((c) => c.checked);
      checks.forEach((c) => (c.checked = !allChecked));
    } else {
      checks.forEach((c) => (c.checked = false));
    }
    updateBulkBar();
    return;
  }

  // Navigation doesn't re-render the sidebar, so the active-row highlight
  // is maintained client-side.
  const item = el?.closest(".session-link")?.closest(".session-item");
  if (item) {
    document
      .querySelectorAll(".session-item.selected")
      .forEach((node) => node.classList.remove("selected"));
    item.classList.add("selected");
    const id = item.getAttribute("data-session-id");
    if (id !== null) {
      markRead(id);
      item.classList.remove("unread");
    }
  }
});

const findSessionItem = (sessionId: string): Element | null =>
  document.querySelector(`.session-item[data-session-id="${sessionId}"]`);

// The sr-only "Running" label only exists in the initial render; keep it in
// sync for sessions whose status changes mid-view via the status feed.
const syncRunIndicator = (
  indicator: Element | null,
  running: boolean,
): void => {
  if (indicator === null) return;
  const sr = indicator.querySelector(".sr-only");
  if (!running) {
    sr?.remove();
    return;
  }
  if (sr !== null) return;
  const node = document.createElement("span");
  node.className = "sr-only";
  node.textContent = "Running";
  indicator.append(node);
};

// A group's indicator mirrors whether any of its members is running.
const setGroupRunning = (group: Element): void => {
  const header = group.querySelector(".group-header");
  if (header === null) return;
  const anyRunning =
    group.querySelector(".session-item[data-running]") !== null;
  header.toggleAttribute("data-running", anyRunning);
  syncRunIndicator(header.querySelector(".run-indicator"), anyRunning);
};

const setStatusIndicator = (sessionId: string, running: boolean): void => {
  const item = findSessionItem(sessionId);
  if (item === null) return;
  item.toggleAttribute("data-running", running);
  const indicator = item.querySelector(".run-indicator");
  indicator?.setAttribute(
    "title",
    running ? "Session is running" : "Session idle",
  );
  syncRunIndicator(indicator, running);
  const group = item.closest(".session-group");
  if (group !== null) setGroupRunning(group);
};

// The agent derives a session name mid-run; the feed pushes it here
// updates live. Empty names render as "(unnamed)" to match displayName.
const setSessionName = (sessionId: string, name: string): void => {
  const item = findSessionItem(sessionId);
  if (item === null) return;
  const node = item.querySelector(".session-name");
  if (node !== null) node.textContent = name === "" ? "(unnamed)" : name;
};

type HtmxAjax = {
  ajax: (
    verb: string,
    path: string,
    options: { target: string; swap: string },
  ) => void;
};

// htmx is read off the global rather than redeclared so this classic
// <script> stays self-contained.
const isHtmxAjax = (value: unknown): value is HtmxAjax =>
  typeof value === "object" &&
  value !== null &&
  "ajax" in value &&
  typeof value.ajax === "function";

// A completing run may have resolved a PR badge that was withheld while
// running; re-fetch the session's meta to reveal it.
const refreshMeta = (sessionId: string): void => {
  if (findSessionItem(sessionId) === null) return;
  const { htmx } = globalThis as { htmx?: unknown };
  if (!isHtmxAjax(htmx)) return;
  htmx.ajax("GET", `/sessions/${sessionId}/sidebar-meta`, {
    target: "#session-list",
    swap: "none",
  });
};

// On (re)connect the server emits a full snapshot of active session ids.
// Reconcile every card to correct indicators that drifted during a disconnect.
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const applySync = (data: string): void => {
  const parsed = parseJson(data);
  if (!isStringArray(parsed)) return;
  const active = new Set(parsed);
  for (const item of document.querySelectorAll<HTMLElement>(
    ".session-item[data-session-id]",
  )) {
    const id = item.dataset.sessionId;
    if (id !== undefined) setStatusIndicator(id, active.has(id));
  }
};

// Unread when a run finishes in a session that isn't the open one; read on click.
const UNREAD_KEY = "glv-unread";

// localStorage throws in private mode or when disabled; fall back to no-op.
const unreadStorage = (): Storage | null => {
  try {
    return localStorage ?? null;
  } catch {
    return null;
  }
};

const loadUnread = (): string[] => {
  const storage = unreadStorage();
  if (storage === null) return [];
  const parsed = parseJson(storage.getItem(UNREAD_KEY) ?? "");
  return isStringArray(parsed) ? parsed : [];
};

const unread = new Set<string>(loadUnread());

const saveUnread = (): void => {
  const storage = unreadStorage();
  if (storage === null) return;
  storage.setItem(UNREAD_KEY, JSON.stringify([...unread]));
};

const markUnread = (sessionId: string): void => {
  unread.add(sessionId);
  saveUnread();
};

const markRead = (sessionId: string): void => {
  unread.delete(sessionId);
  saveUnread();
};

// The currently-open session — mirrors stream.ts's transcript-root selector so
// the two scripts agree on what "open" means.
const openSessionId = (): string | null =>
  document
    .querySelector("#detail-pane [data-session-id]")
    ?.getAttribute("data-session-id") ?? null;

const applyUnread = (): void => {
  const items = document.querySelectorAll<HTMLElement>(
    ".session-item[data-session-id]",
  );
  const present = new Set<string>();
  for (const item of items) {
    const id = item.dataset.sessionId;
    if (id !== undefined) present.add(id);
  }
  const stale = [...unread].filter((id) => !present.has(id));
  if (stale.length > 0) {
    for (const id of stale) unread.delete(id);
    saveUnread();
  }
  for (const item of items) {
    const id = item.dataset.sessionId;
    if (id !== undefined) item.classList.toggle("unread", unread.has(id));
  }
};

type StatusPayload = { sessionId: string; status: string };

const isStatusPayload = (value: unknown): value is StatusPayload =>
  typeof value === "object" &&
  value !== null &&
  "sessionId" in value &&
  typeof value.sessionId === "string" &&
  "status" in value &&
  typeof value.status === "string";

const onStatusEvent = (data: string): void => {
  const parsed = parseJson(data);
  if (!isStatusPayload(parsed)) return;
  const running = parsed.status !== "done";
  setStatusIndicator(parsed.sessionId, running);
  if (running) return;
  refreshMeta(parsed.sessionId);
  if (openSessionId() === parsed.sessionId) return;
  markUnread(parsed.sessionId);
  findSessionItem(parsed.sessionId)?.classList.add("unread");
};

type RenamePayload = { sessionId: string; name: string };

const isRenamePayload = (value: unknown): value is RenamePayload =>
  typeof value === "object" &&
  value !== null &&
  "sessionId" in value &&
  typeof value.sessionId === "string" &&
  "name" in value &&
  typeof value.name === "string";

const onRenameEvent = (data: string): void => {
  const parsed = parseJson(data);
  if (!isRenamePayload(parsed)) return;
  setSessionName(parsed.sessionId, parsed.name);
};

const STATUS_RECONNECT_BASE_MS = 1000;
const STATUS_RECONNECT_MAX_MS = 30000;

// Lives outside #session-list so it survives detail-pane swaps and OOB sidebar
// refreshes.
let statusSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = STATUS_RECONNECT_BASE_MS;

// A permanent close never auto-reconnects, so without this the sidebar's
// running/idle indicators would go stale for the rest of the page session.
const scheduleReconnect = (): void => {
  if (reconnectTimer !== null) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, STATUS_RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectStatusFeed();
  }, delay);
};

const connectStatusFeed = (): void => {
  if (statusSource !== null) return;
  statusSource = new EventSource("/events/status");
  statusSource.addEventListener("open", () => {
    reconnectDelay = STATUS_RECONNECT_BASE_MS;
  });
  statusSource.addEventListener("sync", (e) => {
    if (!(e instanceof MessageEvent)) return;
    applySync(e.data);
  });
  statusSource.addEventListener("status", (e) => {
    if (!(e instanceof MessageEvent)) return;
    onStatusEvent(e.data);
  });
  statusSource.addEventListener("rename", (e) => {
    if (!(e instanceof MessageEvent)) return;
    onRenameEvent(e.data);
  });
  // The poll loop emits "done" when it exhausts; close the EventSource and
  // reconnect with backoff instead of spinning into a reconnect storm.
  statusSource.addEventListener("done", () => {
    if (statusSource !== null) {
      statusSource.close();
      statusSource = null;
    }
    scheduleReconnect();
  });
  // EventSource auto-reconnects on transient failures, so only act on a
  // permanent close.
  statusSource.addEventListener("error", () => {
    if (statusSource?.readyState !== EventSource.CLOSED) return;
    statusSource = null;
    scheduleReconnect();
  });
};

updateBulkBar();
applyUnread();
connectStatusFeed();

// Archive's OOB re-render of #session-list wipes the .unread classes; re-apply
// after the swap restores the list.
document.addEventListener("htmx:afterSwap", (e) => {
  if (!(e instanceof CustomEvent)) return;
  if (e.detail?.target?.id === "session-list") applyUnread();
});

export {};
