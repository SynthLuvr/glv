declare const htmx: {
  ajax: (
    verb: string,
    path: string,
    options: { target: string; swap: string },
  ) => void;
};

let activeSource: EventSource | null = null;

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

type StreamStatus = {
  status: string;
  queuePosition?: number;
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
    hint.textContent = "Running…";
  } else if (data.status === "error" && data.error != null) {
    hint.className = "status-hint error";
    hint.textContent = data.error;
  }
};

const connectRunner = (root: Element): void => {
  const sessionId = root.getAttribute("data-session-id");
  const output = root.querySelector("#live-output");

  activeSource = new EventSource(`/sessions/${sessionId}/stream`);

  // Server replays all accumulated lines on reconnect; clear to avoid duplicates.
  activeSource.addEventListener("open", () => {
    if (output !== null) output.innerHTML = "";
  });

  activeSource.addEventListener("status", (e) => {
    try {
      updateStatusHint(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore malformed status payloads */
    }
  });

  activeSource.addEventListener("line", (e) => {
    const line = (e as MessageEvent).data;
    if (line !== "" && output !== null) {
      output.insertAdjacentHTML("beforeend", line);
      scrollToBottom();
    }
  });

  activeSource.addEventListener("done", () => {
    teardown();
    if (typeof htmx !== "undefined")
      htmx.ajax("GET", `/sessions/${sessionId}`, {
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

  activeSource.addEventListener("append", (e) => {
    const html = (e as MessageEvent).data;
    if (html !== "" && messages !== null) {
      messages.insertAdjacentHTML("beforeend", html);
      if (nearBottom()) scrollToBottom();
    }
  });

  activeSource.addEventListener("error", teardownIfClosed);
};

const init = (): void => {
  teardown();
  const root = document.querySelector("[data-session-id]");
  if (root === null) return;
  const status = root.getAttribute("data-run-status");
  if (status === "queued" || status === "running") connectRunner(root);
  else connectTail(root);
};

document.addEventListener("DOMContentLoaded", init);
document.body.addEventListener("htmx:afterSwap", (e) => {
  if ((e as CustomEvent).detail.target?.id === "detail-pane") init();
});
