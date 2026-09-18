import { queuedSuffix, type ToolRun, toolRunText } from "../format/duration.js";
import {
  type MessageEntry,
  type MetaUpdate,
  onSessionEvent,
  type SessionRenamePayload,
  type SessionStatusPayload,
} from "../sse-events.js";
import { getHtmx, htmxSwapTarget } from "./htmx.js";
import { fillPromptInput } from "./shared.js";

let activeSource: EventSource | null = null;

// A follow-up draft captured before a prompt-bar swap so it survives the form
// replacement (the bar shape changes when a run starts/ends).
let pendingBarDraft: string | undefined;
let lastBusy: boolean | undefined;

// Reads the live draft out of the prompt bar. Called twice per swap:
// when the busy/idle status event asks for the new bar, and again at
// htmx:beforeSwap — the old bar is still in the document right before
// its replacement, so text typed while the fragment was in flight (a
// slow round trip leaves a real window) is caught instead of lost.
const captureBarDraft = (): void => {
  const textarea = document.querySelector<HTMLTextAreaElement>(".prompt-input");
  if (textarea !== null) pendingBarDraft = textarea.value;
};

// While a tool call is in flight, the status hint carries a live elapsed
// clock. The element is re-queried on every tick because the prompt bar is
// swapped wholesale on busy/idle transitions; a vanished hint means the run
// moved on and the ticker retires itself.
let activeTool: ToolRun | undefined;
let activeQueued = 0;
let toolTimer: ReturnType<typeof setInterval> | undefined;

const toolHintText = (tool: ToolRun, queued: number): string =>
  `${toolRunText(tool)}${queuedSuffix(queued)}`;

const stopToolTicker = (): void => {
  if (toolTimer !== undefined) clearInterval(toolTimer);
  toolTimer = undefined;
  activeTool = undefined;
};

const tickToolHint = (): void => {
  const hint = document.querySelector(".status-hint[data-tool-running]");
  if (hint === null || activeTool === undefined) {
    stopToolTicker();
    return;
  }
  // A ticking clock is noise for screen readers; the meaningful
  // transitions (tool started / finished) still announce via the polite
  // region that updateStatusHint restores.
  hint.setAttribute("aria-live", "off");
  hint.textContent = toolHintText(activeTool, activeQueued);
};

const startToolTicker = (): void => {
  if (toolTimer !== undefined) return;
  toolTimer = setInterval(tickToolHint, 1000);
};

const teardown = (): void => {
  if (activeSource !== null) {
    activeSource.close();
    activeSource = null;
  }
  stopToolTicker();
};

const scrollToBottom = (): void => {
  const pane = document.getElementById("detail-pane");
  if (pane !== null) pane.scrollTop = pane.scrollHeight;
};

// Only auto-scroll when the reader is near the bottom, so reading history
// isn't interrupted by incoming messages.
const nearBottom = (): boolean => {
  const pane = document.getElementById("detail-pane");
  if (pane === null) return false;
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 160;
};

// #detail-pane survives htmx navigations (only its innerHTML is swapped), so
// revisiting a session would otherwise jump back to the top. Remember each
// session's scroll offset in localStorage and restore it on return.
const STORAGE_PREFIX = "glv:scroll:";
const SAVE_DEBOUNCE_MS = 150;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let scrollMemoryWired = false;

// Scope to #detail-pane: sidebar cards also carry data-session-id (for the
// running indicator) and precede the pane, so a bare selector would match a
// card instead of the transcript root.
const sessionRoot = (): Element | null =>
  document.querySelector("#detail-pane [data-session-id]");

// localStorage throws in private mode or when disabled; fall back to no memory.
const safeStorage = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

const savedOffset = (id: string | null): number => {
  const storage = safeStorage();
  if (storage === null || id === null) return 0;
  const value = Number.parseInt(storage.getItem(STORAGE_PREFIX + id) ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const saveScroll = (): void => {
  const pane = document.getElementById("detail-pane");
  const id = sessionRoot()?.getAttribute("data-session-id") ?? null;
  const storage = safeStorage();
  if (pane === null || id === null || storage === null) return;
  try {
    storage.setItem(STORAGE_PREFIX + id, String(Math.round(pane.scrollTop)));
  } catch {
    /* quota exceeded — ignore */
  }
};

// Save on every scroll (debounced) so a reload or back-button still has the
// last offset, not only when navigating away.
const scheduleSave = (): void => {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveScroll, SAVE_DEBOUNCE_MS);
};

// Land on the saved offset after a swap. With nothing remembered, default to
// the bottom for an active run (so live output is visible) and the top
// otherwise.
const restoreScroll = (): void => {
  const root = sessionRoot();
  const pane = document.getElementById("detail-pane");
  if (root === null || pane === null) return;
  const saved = savedOffset(root.getAttribute("data-session-id"));
  if (saved > 0) {
    pane.scrollTop = saved;
    return;
  }
  const status = root.getAttribute("data-run-status");
  if (status === "queued" || status === "running")
    pane.scrollTop = pane.scrollHeight;
};

// The body-level beforeSwap listener is wired once; the scroll listener
// follows the pane element, because a history restore replaces the pane and
// detaches the old binding.
let scrollMemoryPane: Element | null = null;

const wireScrollMemory = (): void => {
  const pane = document.getElementById("detail-pane");
  if (pane === null) return;
  if (scrollMemoryPane !== pane) {
    scrollMemoryPane?.removeEventListener("scroll", scheduleSave);
    scrollMemoryPane = pane;
    pane.addEventListener("scroll", scheduleSave, { passive: true });
  }
  if (scrollMemoryWired) return;
  document.body.addEventListener("htmx:beforeSwap", (e) => {
    if (htmxSwapTarget(e)?.id === "detail-pane") saveScroll();
  });
  scrollMemoryWired = true;
};

// Insert a message at the correct index so the transcript stays sequenced
// even when an empty row (absent from the DOM) later gains content.
const insertMessageInOrder = (
  container: Element,
  index: number,
  html: string,
): void => {
  for (const sibling of Array.from(container.children)) {
    const sibIndex = Number(sibling.getAttribute("data-msg-index"));
    if (!Number.isNaN(sibIndex) && sibIndex > index) {
      sibling.insertAdjacentHTML("beforebegin", html);
      return;
    }
  }
  container.insertAdjacentHTML("beforeend", html);
};

// #no-messages is a sibling of #messages, so it survives appends; remove it
// once real content arrives.
const removeEmptyState = (): void => {
  document.getElementById("no-messages")?.remove();
};

// Append a message, skipping if its index is already present (idempotent on
// reconnect — the cursor-based catch-up may re-send rows the client has).
const appendMessage = (
  messages: Element,
  index: number,
  html: string,
): void => {
  if (html === "") return;
  if (messages.querySelector(`[data-msg-index="${index}"]`) !== null) return;
  insertMessageInOrder(messages, index, html);
  removeEmptyState();
};

const reconcileMessages = (
  messages: Element,
  entries: MessageEntry[],
): void => {
  for (const entry of entries) appendMessage(messages, entry.index, entry.html);
  if (nearBottom()) scrollToBottom();
};

const applyReplace = (messages: Element | null, entry: MessageEntry): void => {
  if (messages === null || entry.html === "") return;
  const existing = messages.querySelector(`[data-msg-index="${entry.index}"]`);
  if (existing !== null) existing.outerHTML = entry.html;
  else {
    insertMessageInOrder(messages, entry.index, entry.html);
    removeEmptyState();
  }
};

const applyRename = (payload: SessionRenamePayload): void => {
  const title = document.querySelector("#detail-pane .session-title");
  if (title !== null)
    title.textContent = payload.name === "" ? "(unnamed)" : payload.name;
};

const updateMeta = (data: MetaUpdate): void => {
  const setValue = (id: string, value: string, title?: string): void => {
    const chip = document.getElementById(id);
    if (chip === null) return;
    const node = chip.querySelector(".meta-value");
    if (node !== null) node.textContent = value;
    if (title !== undefined) chip.title = title;
  };
  setValue("meta-updated", data.updated, data.updatedTitle);
};

const updateStatusHint = (data: SessionStatusPayload): void => {
  const hint = document.querySelector(".status-hint");
  if (hint === null) return;
  // Every transition re-arms the polite region (the ticker silences it
  // while it owns the element) and resets any stale tool marker first.
  hint.setAttribute("aria-live", "polite");
  hint.removeAttribute("data-tool-running");
  stopToolTicker();
  if (data.status === "queued" && data.queuePosition !== undefined) {
    hint.className = "status-hint queued";
    hint.textContent = `Queued, waiting… (position ${data.queuePosition})`;
  } else if (data.status === "running") {
    hint.className = "status-hint running";
    const count = data.pendingCount ?? 0;
    if (data.tool != null) {
      hint.setAttribute("data-tool-running", "");
      activeTool = data.tool;
      activeQueued = count;
      hint.textContent = toolHintText(data.tool, count);
      startToolTicker();
    } else hint.textContent = `Running…${queuedSuffix(count)}`;
  } else if (data.status === "error" && data.error != null) {
    hint.className = "status-hint error";
    hint.textContent = data.error;
  } else if (
    data.status === "completed" ||
    data.status === "stopped" ||
    data.status === "idle"
  ) {
    hint.className = "status-hint";
    hint.textContent = "";
  }
};

// A chained prompt just started, so its queued card is now live: drop one
// queued card, then remove the empty queue container (and its Clear button).
const dismissQueuedCard = (): void => {
  document.querySelector(".queued-prompt")?.remove();
  const container = document.getElementById("queued-prompts");
  if (container !== null && container.querySelector(".queued-prompt") === null)
    container.remove();
};

// Swap just the prompt bar (Stop/Queue → Send or vice-versa) on a busy/idle
// transition — never the whole transcript. The draft is captured first and
// restored after the swap so unsent text survives.
const updatePromptBar = (
  sessionId: string,
  data: SessionStatusPayload,
): void => {
  const busy = data.status === "queued" || data.status === "running";
  if (busy === lastBusy) return;
  lastBusy = busy;
  const bar = document.querySelector("[data-prompt-bar]");
  if (bar === null) return;
  captureBarDraft();
  const htmx = getHtmx();
  if (htmx !== undefined)
    htmx.ajax(
      "GET",
      `/sessions/${sessionId}/prompt-bar?status=${data.status}`,
      { target: "[data-prompt-bar]", swap: "outerHTML" },
    );
};

const restoreBarDraft = (): void => {
  if (pendingBarDraft === undefined) return;
  const textarea = document.querySelector<HTMLTextAreaElement>(".prompt-input");
  fillPromptInput(textarea, pendingBarDraft);
  pendingBarDraft = undefined;
};

const handleStatus = (sessionId: string, data: SessionStatusPayload): void => {
  // Session deleted mid-connection: close so EventSource stops retrying.
  if (data.status === "deleted") {
    teardown();
    return;
  }
  updateStatusHint(data);
  updatePromptBar(sessionId, data);
};

// Unified session stream. The DB is the source of truth for committed
// messages (#messages); in-memory NDJSON lines stream as a transient preview
// (#live-tail). Cursor-based (Last-Event-ID) reconnects are delta-only, so
// EventSource auto-reconnect is embraced rather than suppressed.
const connect = (root: Element): void => {
  const sessionId = root.getAttribute("data-session-id");
  const messages = document.getElementById("messages");
  const initialStatus = root.getAttribute("data-run-status");
  lastBusy = initialStatus === "queued" || initialStatus === "running";

  activeSource = new EventSource(
    `/sessions/${sessionId}/events?cursor=${root.getAttribute("data-cursor") ?? 0}`,
  );

  onSessionEvent(activeSource, "messages", (data) => {
    if (messages !== null) reconcileMessages(messages, data.entries);
  });

  onSessionEvent(activeSource, "append", (entry) => {
    if (messages === null) return;
    appendMessage(messages, entry.index, entry.html);
    if (nearBottom()) scrollToBottom();
  });

  onSessionEvent(activeSource, "replace", (entry) => {
    applyReplace(messages, entry);
    if (nearBottom()) scrollToBottom();
  });

  onSessionEvent(activeSource, "preview", (html) => {
    const liveTail = document.getElementById("live-tail");
    if (liveTail === null || html === "") return;
    liveTail.insertAdjacentHTML("beforeend", html);
    if (nearBottom()) scrollToBottom();
  });

  // DB messages supersede the transient preview — clear it. The active prompt
  // card (server-rendered on submit) is removed once the committed user row
  // arrives.
  onSessionEvent(activeSource, "preview-clear", () => {
    const liveTail = document.getElementById("live-tail");
    if (liveTail !== null) liveTail.innerHTML = "";
    document.querySelector("[data-active-prompt]")?.remove();
  });

  onSessionEvent(activeSource, "status", (data) => {
    handleStatus(sessionId ?? "", data);
  });

  // A chained prompt started — append its card to the preview tail and dismiss
  // the matching queued-prompt card.
  onSessionEvent(activeSource, "prompt", (html) => {
    const liveTail = document.getElementById("live-tail");
    if (liveTail !== null && html !== "")
      liveTail.insertAdjacentHTML("beforeend", html);
    dismissQueuedCard();
    if (nearBottom()) scrollToBottom();
  });

  onSessionEvent(activeSource, "rename", applyRename);

  onSessionEvent(activeSource, "meta", updateMeta);
};

const init = (): void => {
  teardown();
  wireScrollMemory();
  const root = sessionRoot();
  if (root === null) return;
  restoreScroll();
  connect(root);
};

document.addEventListener("DOMContentLoaded", init);
document.body.addEventListener("htmx:afterSwap", (e) => {
  if (htmxSwapTarget(e)?.id === "detail-pane") {
    init();
    return;
  }
  // The prompt-bar swap landed — restore any captured draft.
  if (pendingBarDraft !== undefined) restoreBarDraft();
});
// The bar is still the old one here — one last draft read so nothing
// typed since the status event is dropped by the replacement.
document.body.addEventListener("htmx:beforeSwap", (e) => {
  const target = htmxSwapTarget(e);
  if (target !== null && target.hasAttribute("data-prompt-bar"))
    captureBarDraft();
});
// History restore swaps the whole body: the restored transcript carries no
// SSE connection, and the scroll binding points at the detached pane. Re-init
// tears down the old stream and reconnects for the restored session.
document.body.addEventListener("htmx:historyRestore", init);
