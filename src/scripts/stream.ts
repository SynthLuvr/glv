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

const scrollToBottom = (): void => {
  const pane = document.getElementById("detail-pane");
  if (pane !== null) pane.scrollTop = pane.scrollHeight;
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

const connect = (root: Element): void => {
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

  activeSource.addEventListener("error", () => {
    // EventSource auto-reconnects on transient failures. Only teardown
    // when the server has truly closed the connection.
    if (activeSource?.readyState === EventSource.CLOSED) teardown();
  });
};

const init = (): void => {
  teardown();
  const root = document.querySelector("[data-session-id]");
  if (root === null) return;
  const status = root.getAttribute("data-run-status");
  if (status !== "queued" && status !== "running") return;
  connect(root);
};

document.addEventListener("DOMContentLoaded", init);
document.body.addEventListener("htmx:afterSwap", (e) => {
  if ((e as CustomEvent).detail.target?.id === "detail-pane") init();
});
