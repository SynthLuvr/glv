let activeSource = null;

const teardown = () => {
  if (activeSource !== null) {
    activeSource.close();
    activeSource = null;
  }
};

const scrollToBottom = () => {
  const pane = document.getElementById("detail-pane");
  if (pane !== null) pane.scrollTop = pane.scrollHeight;
};

const updateStatusHint = (data) => {
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

const connect = (root) => {
  const sessionId = root.getAttribute("data-session-id");
  const output = root.querySelector("#live-output");

  activeSource = new EventSource(`/sessions/${sessionId}/stream`);

  activeSource.addEventListener("status", (e) => {
    try {
      updateStatusHint(JSON.parse(e.data));
    } catch {
      /* ignore malformed status payloads */
    }
  });

  activeSource.addEventListener("line", (e) => {
    if (e.data !== "" && output !== null) {
      output.insertAdjacentHTML("beforeend", e.data);
      scrollToBottom();
    }
  });

  activeSource.addEventListener("done", () => {
    teardown();
    if (typeof htmx !== "undefined") {
      htmx.ajax("GET", `/sessions/${sessionId}`, {
        target: "#detail-pane",
        swap: "innerHTML",
      });
    }
  });

  activeSource.addEventListener("error", () => {
    // EventSource auto-reconnects on transient failures. Only teardown
    // when the server has truly closed the connection.
    if (
      activeSource !== null &&
      activeSource.readyState === EventSource.CLOSED
    ) {
      teardown();
    }
  });
};

const init = () => {
  teardown();
  const root = document.querySelector("[data-session-id]");
  if (root === null) return;
  const status = root.getAttribute("data-run-status");
  if (status !== "queued" && status !== "running") return;
  connect(root);
};

document.addEventListener("DOMContentLoaded", init);
document.body.addEventListener("htmx:afterSwap", (e) => {
  if (e.detail.target?.id === "detail-pane") init();
});
