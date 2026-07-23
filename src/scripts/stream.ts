declare const htmx: {
  ajax: (
    verb: string,
    path: string,
    options: { target: string; swap: string },
  ) => void;
};

let activeSource: EventSource | null = null;

// A follow-up draft captured before a targeted prompt-bar swap so it survives
// the form replacement (the bar shape changes when a run starts/ends).
let pendingBarDraft: string | undefined;
// Tracks the prompt bar's busy/idle mode so only genuine transitions swap.
let lastBusy: boolean | undefined;

const teardown = (): void => {
  if (activeSource !== null) {
    activeSource.close();
    activeSource = null;
  }
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

// #detail-pane and <body> both survive innerHTML swaps, so the listeners only
// need attaching once.
const wireScrollMemory = (): void => {
  if (scrollMemoryWired) return;
  const pane = document.getElementById("detail-pane");
  if (pane === null) return;
  pane.addEventListener("scroll", scheduleSave, { passive: true });
  document.body.addEventListener("htmx:beforeSwap", (e) => {
    if (!(e instanceof CustomEvent)) return;
    if (e.detail?.target?.id === "detail-pane") saveScroll();
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

// Reconcile a catch-up batch from the server (cursor-scoped, so cheap).
const reconcileMessages = (
  messages: Element,
  entries: { index: number; html: string }[],
): void => {
  for (const entry of entries) appendMessage(messages, entry.index, entry.html);
  if (nearBottom()) scrollToBottom();
};

type ReplacePayload = { index: number; html: string };

const applyReplace = (messages: Element | null, data: string): void => {
  if (messages === null) return;
  const parsed: unknown = JSON.parse(data);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("index" in parsed) ||
    typeof (parsed as { index: unknown }).index !== "number" ||
    !("html" in parsed) ||
    typeof (parsed as { html: unknown }).html !== "string"
  )
    return;
  const payload = parsed as ReplacePayload;
  if (payload.html === "") return;
  const existing = messages.querySelector(
    `[data-msg-index="${payload.index}"]`,
  );
  if (existing !== null) existing.outerHTML = payload.html;
  else {
    insertMessageInOrder(messages, payload.index, payload.html);
    removeEmptyState();
  }
};

const applyRename = (data: string): void => {
  const parsed: { name?: unknown } = JSON.parse(data);
  if (typeof parsed.name !== "string") return;
  const title = document.querySelector("#detail-pane .session-title");
  if (title !== null)
    title.textContent = parsed.name === "" ? "(unnamed)" : parsed.name;
};

type MetaUpdate = {
  updated: string;
  updatedTitle: string;
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

type StreamStatus = {
  status: string;
  queuePosition?: number;
  pendingCount?: number;
  error?: string | null;
};

const updateStatusHint = (data: StreamStatus): void => {
  const hint = document.querySelector(".status-hint");
  if (hint === null) return;
  if (data.status === "queued" && data.queuePosition !== undefined) {
    hint.className = "status-hint queued";
    hint.textContent = `Queued, waiting… (position ${data.queuePosition})`;
  } else if (data.status === "running") {
    hint.className = "status-hint running";
    const count = data.pendingCount ?? 0;
    hint.textContent =
      count > 0
        ? `Running… (${count} prompt${count > 1 ? "s" : ""} queued next)`
        : "Running…";
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
const updatePromptBar = (sessionId: string, data: StreamStatus): void => {
  const busy = data.status === "queued" || data.status === "running";
  if (busy === lastBusy) return;
  lastBusy = busy;
  const bar = document.querySelector("[data-prompt-bar]");
  if (bar === null) return;
  const textarea = document.querySelector<HTMLTextAreaElement>(".prompt-input");
  if (textarea !== null && textarea.value !== "")
    pendingBarDraft = textarea.value;
  if (typeof htmx !== "undefined")
    htmx.ajax(
      "GET",
      `/sessions/${sessionId}/prompt-bar?status=${data.status}`,
      { target: "[data-prompt-bar]", swap: "outerHTML" },
    );
};

const restoreBarDraft = (): void => {
  if (pendingBarDraft === undefined) return;
  const textarea = document.querySelector<HTMLTextAreaElement>(".prompt-input");
  if (textarea !== null) textarea.value = pendingBarDraft;
  pendingBarDraft = undefined;
};

// One unified connect: the DB is the single source of truth for committed
// messages (#messages), while in-memory NDJSON lines stream as a transient
// preview (#live-tail) below the transcript. Cursor-based polling means
// reconnects are delta-only, and EventSource auto-reconnect is embraced — the
// error handler does nothing because Last-Event-ID ensures correctness.
const connect = (root: Element): void => {
  const sessionId = root.getAttribute("data-session-id");
  const messages = document.getElementById("messages");
  const initialStatus = root.getAttribute("data-run-status");
  lastBusy = initialStatus === "queued" || initialStatus === "running";

  activeSource = new EventSource(
    `/sessions/${sessionId}/events?cursor=${root.getAttribute("data-cursor") ?? 0}`,
  );

  activeSource.addEventListener("messages", (e) => {
    if (!(e instanceof MessageEvent) || messages === null) return;
    try {
      const { entries } = JSON.parse(e.data) as {
        entries: { index: number; html: string }[];
      };
      reconcileMessages(messages, entries);
    } catch {
      /* ignore malformed payload */
    }
  });

  activeSource.addEventListener("append", (e) => {
    if (!(e instanceof MessageEvent) || messages === null) return;
    try {
      const { index, html } = JSON.parse(e.data) as {
        index: number;
        html: string;
      };
      appendMessage(messages, index, html);
      if (nearBottom()) scrollToBottom();
    } catch {
      /* ignore malformed payload */
    }
  });

  activeSource.addEventListener("replace", (e) => {
    if (!(e instanceof MessageEvent)) return;
    try {
      applyReplace(messages, e.data);
      if (nearBottom()) scrollToBottom();
    } catch {
      /* ignore malformed payload */
    }
  });

  activeSource.addEventListener("preview", (e) => {
    if (!(e instanceof MessageEvent)) return;
    const liveTail = document.getElementById("live-tail");
    if (liveTail === null || e.data === "") return;
    liveTail.insertAdjacentHTML("beforeend", e.data);
    if (nearBottom()) scrollToBottom();
  });

  // DB messages supersede the transient preview — clear it. The active
  // prompt card (server-rendered on submit) is also removed now that the
  // committed user-message row covers it.
  activeSource.addEventListener("preview-clear", () => {
    const liveTail = document.getElementById("live-tail");
    if (liveTail !== null) liveTail.innerHTML = "";
    document.querySelector("[data-active-prompt]")?.remove();
  });

  activeSource.addEventListener("status", (e) => {
    if (!(e instanceof MessageEvent)) return;
    try {
      const data = JSON.parse(e.data) as StreamStatus;
      // Session deleted mid-connection: close so EventSource stops retrying.
      if (data.status === "deleted") {
        teardown();
        return;
      }
      updateStatusHint(data);
      updatePromptBar(sessionId ?? "", data);
    } catch {
      /* ignore malformed status payload */
    }
  });

  // A chained prompt started — append its card to the preview tail and
  // dismiss the corresponding queued-prompt card.
  activeSource.addEventListener("prompt", (e) => {
    if (!(e instanceof MessageEvent)) return;
    const liveTail = document.getElementById("live-tail");
    if (liveTail !== null && e.data !== "")
      liveTail.insertAdjacentHTML("beforeend", e.data);
    dismissQueuedCard();
    if (nearBottom()) scrollToBottom();
  });

  activeSource.addEventListener("rename", (e) => {
    if (!(e instanceof MessageEvent)) return;
    try {
      applyRename(e.data);
    } catch {
      /* ignore malformed rename payload */
    }
  });

  activeSource.addEventListener("meta", (e) => {
    if (!(e instanceof MessageEvent)) return;
    try {
      updateMeta(JSON.parse(e.data) as MetaUpdate);
    } catch {
      /* ignore malformed meta payload */
    }
  });

  // EventSource auto-reconnects on transient failures; Last-Event-ID lets the
  // server resume from the right cursor. Do nothing — embrace the reconnect.
  activeSource.addEventListener("error", () => {
    /* EventSource handles reconnection natively */
  });
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
  if (!(e instanceof CustomEvent)) return;
  if (e.detail?.target?.id === "detail-pane") {
    init();
    return;
  }
  // The prompt-bar swap landed — restore any captured draft.
  if (pendingBarDraft !== undefined) restoreBarDraft();
});
