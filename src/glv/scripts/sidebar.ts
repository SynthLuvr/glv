import {
  type FeedNamesPayload,
  type FeedRenamePayload,
  type FeedStatusPayload,
  onFeedEvent,
  parsePayload,
  StringListPayload,
} from "../sse-events.js";
import { getHtmx, htmxRequestDetail } from "./htmx.js";
import { onSessionListSwap, safeStorage } from "./shared";

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
    selectItem(item);
    const id = item.getAttribute("data-session-id");
    if (id !== null) {
      markRead(id);
      item.classList.remove("unread");
    }
  }
});

const findSessionItem = (sessionId: string): Element | null =>
  document.querySelector(`.session-item[data-session-id="${sessionId}"]`);

// The open-session highlight is client-side state — the server renders it
// only on full page loads — so navigation and sidebar re-renders maintain
// it here. A null item clears the highlight.
const selectItem = (item: Element | null): void => {
  document.querySelectorAll(".session-item.selected").forEach((node) => {
    node.classList.remove("selected");
    node.querySelector(".session-link")?.removeAttribute("aria-current");
  });
  if (item === null) return;
  item.classList.add("selected");
  item.querySelector(".session-link")?.setAttribute("aria-current", "page");
};

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

// The agent derives a session name mid-run; the feed pushes it here and
// the list updates live. Empty names render as "(unnamed)" to match
// displayName.
const setSessionName = (sessionId: string, name: string): void => {
  const item = findSessionItem(sessionId);
  if (item === null) return;
  const node = item.querySelector(".session-name");
  if (node !== null) node.textContent = name === "" ? "(unnamed)" : name;
};

// A completing run may have resolved a PR badge that was withheld while
// running; re-fetch the session's meta to reveal it.
const refreshMeta = (sessionId: string): void => {
  if (findSessionItem(sessionId) === null) return;
  const htmx = getHtmx();
  if (htmx === undefined) return;
  htmx.ajax("GET", `/sessions/${sessionId}/sidebar-meta`, {
    target: "#session-list",
    swap: "none",
  });
};

// On (re)connect the server emits a full snapshot of active session ids.
// Reconcile every card to correct indicators that drifted during a disconnect.
const applySync = (activeIds: string[]): void => {
  const active = new Set(activeIds);
  for (const item of document.querySelectorAll<HTMLElement>(
    ".session-item[data-session-id]",
  )) {
    const id = item.dataset.sessionId;
    if (id !== undefined) setStatusIndicator(id, active.has(id));
  }
};

// Unread when a run finishes in a session that isn't the open one; read on click.
const UNREAD_KEY = "glv-unread";

const loadUnread = (): string[] => {
  const storage = safeStorage();
  if (storage === null) return [];
  return (
    parsePayload(StringListPayload, storage.getItem(UNREAD_KEY) ?? "") ?? []
  );
};

const unread = new Set<string>(loadUnread());

const saveUnread = (): void => {
  const storage = safeStorage();
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

// ---------- new-session queue wait ----------
// A create submitted while the concurrency pool is full queues and the
// form's POST stays pending until a slot frees. The queued session has no
// sidebar row yet — the agent writes it only once the run starts (goose
// queues under a temp key discovered afterwards, claude under a
// pre-assigned --session-id) — so the feed's queued state for that id
// would otherwise be invisible and the submit would read as a silent
// hang. While the create POST is in flight, a status for an id the
// sidebar doesn't know drives a hint in the form: queued waits for a free
// slot, running means the agent is starting, and a terminal status (or
// the response itself) clears it.

const NEW_SESSION_FORM = "form.new-session-form";

let createPending = false;

const showQueueWaitHint = (text: string): void => {
  const form = document.querySelector(NEW_SESSION_FORM);
  if (form === null) return;
  let hint = form.querySelector("[data-queue-wait]");
  if (hint === null) {
    hint = document.createElement("p");
    hint.className = "status-hint queued";
    hint.setAttribute("data-queue-wait", "");
    hint.setAttribute("aria-live", "polite");
    const actions = form.querySelector(".form-actions");
    if (actions === null) form.append(hint);
    else actions.before(hint);
  }
  hint.textContent = text;
};

const removeQueueWaitHint = (): void => {
  document.querySelector(`${NEW_SESSION_FORM} [data-queue-wait]`)?.remove();
};

const isCreateSubmit = (e: Event): boolean => {
  const requestConfig = htmxRequestDetail(e).requestConfig;
  if (requestConfig === undefined) return false;
  const { path, verb, elt } = requestConfig;
  if (path !== "/sessions" || verb?.toUpperCase() !== "POST") return false;
  return elt instanceof Element && elt.matches(NEW_SESSION_FORM);
};

document.body.addEventListener("htmx:beforeRequest", (e) => {
  if (isCreateSubmit(e)) createPending = true;
});

// Cleared on every settle, success or not: the swapped-in response replaces
// the form either way, but a request that dies without a swap (network
// error, proxy timeout) must not leave the hint behind.
document.body.addEventListener("htmx:afterRequest", (e) => {
  if (!isCreateSubmit(e)) return;
  createPending = false;
  removeQueueWaitHint();
});

const updateQueueWaitHint = (payload: FeedStatusPayload): void => {
  // An id with no sidebar row while the create pends is this create's
  // queued run — the feed emits deltas on change, so the first such event
  // is the queue state arriving.
  if (!createPending || findSessionItem(payload.sessionId) !== null) return;
  if (payload.status === "queued")
    showQueueWaitHint("Waiting for a free slot…");
  else if (payload.status === "running")
    showQueueWaitHint("Starting the session…");
  else removeQueueWaitHint();
};

const onStatusEvent = (payload: FeedStatusPayload): void => {
  updateQueueWaitHint(payload);
  const running = payload.status !== "done";
  setStatusIndicator(payload.sessionId, running);
  if (running) return;
  refreshMeta(payload.sessionId);
  if (openSessionId() === payload.sessionId) return;
  markUnread(payload.sessionId);
  findSessionItem(payload.sessionId)?.classList.add("unread");
};

// On (re)connect the server answers with one `names` snapshot carrying
// every sidebar session's current name; `rename` fires only for the
// deltas after that.
const onNamesSnapshot = (payload: FeedNamesPayload): void => {
  for (const { sessionId, name } of payload) setSessionName(sessionId, name);
};

const onRenameEvent = (payload: FeedRenamePayload): void => {
  setSessionName(payload.sessionId, payload.name);
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
  onFeedEvent(statusSource, "sync", applySync);
  onFeedEvent(statusSource, "names", onNamesSnapshot);
  onFeedEvent(statusSource, "status", onStatusEvent);
  onFeedEvent(statusSource, "rename", onRenameEvent);
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

// Server re-renders of #session-list (archive's response, rename's
// out-of-band swap, the group operations) arrive without the client-side
// classes; re-apply unread and re-derive the open-session highlight from
// the open transcript after every list swap.
const applySelected = (): void => {
  const openId = openSessionId();
  selectItem(openId === null ? null : findSessionItem(openId));
};

onSessionListSwap(() => {
  applyUnread();
  applySelected();
});
