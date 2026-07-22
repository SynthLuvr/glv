declare const htmx: {
  ajax: (
    verb: string,
    path: string,
    options: { target: string; swap: string },
  ) => void;
};

let activeSource: EventSource | null = null;

// A follow-up prompt the user was typing when a run completed; preserved
// across the run-completion detail-pane swap so it isn't silently destroyed.
let pendingDraft: string | undefined;

const teardown = (): void => {
  if (activeSource !== null) {
    activeSource.close();
    activeSource = null;
  }
};

// EventSource auto-reconnects on transient failures; only teardown once the
// server has truly closed the connection.
const teardownIfClosed = (): void => {
  if (activeSource?.readyState === EventSource.CLOSED) teardown();
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

// A message that was previously empty (and thus absent from the DOM) may
// later gain content. Insert it in timestamp order rather than always at the
// end, so the transcript stays correctly sequenced.
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

// The "no messages" placeholder is a sibling of #messages; clear it once the
// tail stream delivers real content so it doesn't linger above new messages.
const removeEmptyState = (): void => {
  document.getElementById("no-messages")?.remove();
};

type ReplacePayload = { index: number; html: string };

const isReplacePayload = (value: unknown): value is ReplacePayload =>
  typeof value === "object" &&
  value !== null &&
  "index" in value &&
  typeof value.index === "number" &&
  "html" in value &&
  typeof value.html === "string";

const applyReplace = (messages: Element | null, data: string): void => {
  if (messages === null) return;
  const parsed: unknown = JSON.parse(data);
  if (!isReplacePayload(parsed)) return;
  if (parsed.html === "") return;
  const existing = messages.querySelector(`[data-msg-index="${parsed.index}"]`);
  if (existing !== null) existing.outerHTML = parsed.html;
  else {
    insertMessageInOrder(messages, parsed.index, parsed.html);
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
  } else if (data.status === "completed" || data.status === "stopped") {
    // A terminal status clears the "Running…" hint immediately rather than
    // leaving it stale until the done-triggered re-render lands.
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

const connectRunner = (root: Element): void => {
  const sessionId = root.getAttribute("data-session-id");
  const output = root.querySelector("#live-output");
  // Number of prompts that had already started when this connection opened;
  // the first that many "prompt" events are replays (for labelling output)
  // and must not dismiss a queued-prompt card.
  let baselineStarted = 0;
  let promptCount = 0;
  let statusInitialized = false;

  activeSource = new EventSource(`/sessions/${sessionId}/stream`);

  // Server replays all accumulated lines on reconnect; clear to avoid duplicates.
  activeSource.addEventListener("open", () => {
    if (output !== null) output.innerHTML = "";
    // The server-rendered active prompt card duplicates the stream's replay of
    // started prompts inside #live-output; drop it so the prompt isn't shown twice.
    document.querySelector("[data-active-prompt]")?.remove();
  });

  activeSource.addEventListener("status", (e) => {
    if (!(e instanceof MessageEvent)) return;
    try {
      const data = JSON.parse(e.data);
      updateStatusHint(data);
      if (!statusInitialized) {
        baselineStarted = data.startedCount ?? 0;
        statusInitialized = true;
      }
    } catch {
      /* ignore malformed status payloads */
    }
  });

  activeSource.addEventListener("prompt", (e) => {
    if (!(e instanceof MessageEvent)) return;
    const html = e.data;
    if (html === "" || output === null) return;
    output.insertAdjacentHTML("beforeend", html);
    promptCount++;
    // Only a genuine queued→running transition dismisses a queued card;
    // replays of prompts already started before connecting must not.
    if (promptCount > baselineStarted) dismissQueuedCard();
    if (nearBottom()) scrollToBottom();
  });

  activeSource.addEventListener("line", (e) => {
    if (!(e instanceof MessageEvent)) return;
    const line = e.data;
    if (line !== "" && output !== null) {
      output.insertAdjacentHTML("beforeend", line);
      if (nearBottom()) scrollToBottom();
    }
  });

  activeSource.addEventListener("done", () => {
    teardown();
    // Preserve any unsent follow-up text across the full-pane re-render so a
    // run completing mid-typing doesn't silently destroy the user's draft.
    const textarea =
      document.querySelector<HTMLTextAreaElement>(".prompt-input");
    if (textarea !== null && textarea.value !== "")
      pendingDraft = textarea.value;
    if (typeof htmx !== "undefined")
      htmx.ajax("GET", `/sessions/${sessionId}?sidebar=1`, {
        target: "#detail-pane",
        swap: "innerHTML",
      });
  });

  activeSource.addEventListener("error", teardownIfClosed);
};

const connectTail = (root: Element): void => {
  const sessionId = root.getAttribute("data-session-id");
  const messages = document.getElementById("messages");

  activeSource = new EventSource(`/sessions/${sessionId}/tail`);

  // The server emits the full current message set on every (re)connect so
  // messages written during a disconnect gap are never lost. Clear and
  // re-render to make this idempotent across reconnects.
  activeSource.addEventListener("sync", (e) => {
    if (!(e instanceof MessageEvent)) return;
    if (messages === null) return;
    try {
      const entries: unknown = JSON.parse(e.data);
      if (!Array.isArray(entries)) return;
      messages.innerHTML = "";
      for (const html of entries)
        if (typeof html === "string")
          messages.insertAdjacentHTML("beforeend", html);
      if (messages.querySelector(".message") !== null) removeEmptyState();
      if (nearBottom()) scrollToBottom();
    } catch {
      /* ignore malformed sync payloads */
    }
  });

  activeSource.addEventListener("append", (e) => {
    if (!(e instanceof MessageEvent)) return;
    const html = e.data;
    if (html !== "" && messages !== null) {
      removeEmptyState();
      messages.insertAdjacentHTML("beforeend", html);
      if (nearBottom()) scrollToBottom();
    }
  });

  activeSource.addEventListener("replace", (e) => {
    if (!(e instanceof MessageEvent)) return;
    try {
      applyReplace(messages, e.data);
      if (nearBottom()) scrollToBottom();
    } catch {
      /* ignore malformed replace payloads */
    }
  });

  activeSource.addEventListener("meta", (e) => {
    if (!(e instanceof MessageEvent)) return;
    try {
      updateMeta(JSON.parse(e.data));
    } catch {
      /* ignore malformed meta payloads */
    }
  });

  activeSource.addEventListener("rename", (e) => {
    if (!(e instanceof MessageEvent)) return;
    try {
      applyRename(e.data);
    } catch {
      /* ignore malformed rename payloads */
    }
  });

  // Server closed the stream; teardown so EventSource doesn't reconnect.
  activeSource.addEventListener("done", () => {
    teardown();
  });

  activeSource.addEventListener("error", () => {
    teardownIfClosed();
  });
};

const init = (): void => {
  teardown();
  wireScrollMemory();
  const root = sessionRoot();
  if (root === null) return;
  const status = root.getAttribute("data-run-status");
  // Restore before connecting so an active run's first streamed line doesn't
  // fight a stale default position.
  restoreScroll();
  if (status === "queued" || status === "running") connectRunner(root);
  else connectTail(root);
  // Restore a follow-up draft clobbered by the run-completion detail-pane swap
  // (the "done" handler captured it before triggering the re-render).
  if (pendingDraft !== undefined) {
    const textarea =
      document.querySelector<HTMLTextAreaElement>(".prompt-input");
    if (textarea !== null) textarea.value = pendingDraft;
    pendingDraft = undefined;
  }
};

document.addEventListener("DOMContentLoaded", init);
document.body.addEventListener("htmx:afterSwap", (e) => {
  if (!(e instanceof CustomEvent)) return;
  if (e.detail.target?.id === "detail-pane") init();
});
