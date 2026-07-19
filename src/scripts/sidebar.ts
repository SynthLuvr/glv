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
  if (toggle) toggle.textContent = allChecked ? "Deselect all" : "Select all";
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
  }
});

const findSessionItem = (sessionId: string): Element | null =>
  document.querySelector(`.session-item[data-session-id="${sessionId}"]`);

const setStatusIndicator = (sessionId: string, running: boolean): void => {
  const item = findSessionItem(sessionId);
  if (item === null) return;
  item.toggleAttribute("data-running", running);
  item
    .querySelector(".run-indicator")
    ?.setAttribute("title", running ? "Session is running" : "Session idle");
};

// Goose derives a session name mid-run; the feed pushes it here so the card
// updates live. Empty names render as "(unnamed)" to match displayName.
const setSessionName = (sessionId: string, name: string): void => {
  const item = findSessionItem(sessionId);
  if (item === null) return;
  const node = item.querySelector(".session-name");
  if (node !== null) node.textContent = name === "" ? "(unnamed)" : name;
};

const safeParse = (data: string): unknown => {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

// On (re)connect the server emits a full snapshot of active session ids.
// Reconcile every card to correct indicators that drifted during a disconnect.
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const applySync = (data: string): void => {
  const parsed = safeParse(data);
  if (!isStringArray(parsed)) return;
  const active = new Set(parsed);
  for (const item of document.querySelectorAll<HTMLElement>(
    ".session-item[data-session-id]",
  )) {
    const id = item.dataset.sessionId;
    if (id !== undefined) setStatusIndicator(id, active.has(id));
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
  const parsed = safeParse(data);
  if (!isStatusPayload(parsed)) return;
  setStatusIndicator(parsed.sessionId, parsed.status !== "done");
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
  const parsed = safeParse(data);
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
  // EventSource auto-reconnects on transient failures, so only act on a
  // permanent close.
  statusSource.addEventListener("error", () => {
    if (statusSource?.readyState !== EventSource.CLOSED) return;
    statusSource = null;
    scheduleReconnect();
  });
};

updateBulkBar();
connectStatusFeed();
