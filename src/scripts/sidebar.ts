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

// Toggles the running indicator on a sidebar session card. The dot element is
// always present in the DOM (server-rendered); CSS shows/hides it based on the
// data-running attribute so the client only flips a boolean, never rebuilds
// markup.
const setStatusIndicator = (sessionId: string, running: boolean): void => {
  const item = document.querySelector(
    `.session-item[data-session-id="${sessionId}"]`,
  );
  if (item === null) return;
  if (running) item.setAttribute("data-running", "");
  else item.removeAttribute("data-running");
};

// On (re)connect the server emits a full snapshot of active session ids.
// Reconcile every card so indicators that drifted during a disconnect are
// corrected — including sessions that ended while we were away.
const applySync = (data: string): void => {
  let ids: string[];
  try {
    ids = JSON.parse(data) as string[];
  } catch {
    return;
  }
  const active = new Set(ids);
  for (const item of document.querySelectorAll<HTMLElement>(
    ".session-item[data-session-id]",
  )) {
    const id = item.dataset.sessionId;
    if (id !== undefined) setStatusIndicator(id, active.has(id));
  }
};

const onStatusEvent = (data: string): void => {
  try {
    const { sessionId, status } = JSON.parse(data) as {
      sessionId: string;
      status: string;
    };
    setStatusIndicator(sessionId, status !== "done");
  } catch {
    /* ignore malformed status payloads */
  }
};

// One persistent EventSource for the whole sidebar — survives detail-pane
// swaps and out-of-band sidebar refreshes because it lives outside
// #session-list.
let statusSource: EventSource | null = null;

const connectStatusFeed = (): void => {
  if (statusSource !== null) return;
  statusSource = new EventSource("/events/status");
  statusSource.addEventListener("sync", (e) => {
    applySync((e as MessageEvent).data);
  });
  statusSource.addEventListener("status", (e) => {
    onStatusEvent((e as MessageEvent).data);
  });
  // EventSource auto-reconnects on transient failures; only null our
  // reference once the connection is truly closed so we don't leak duplicates.
  statusSource.addEventListener("error", () => {
    if (statusSource?.readyState === EventSource.CLOSED) statusSource = null;
  });
};

updateBulkBar();
connectStatusFeed();
