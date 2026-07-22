import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// stream.ts is a side-effect-only browser script (no exports, loaded as a
// classic <script>), so tsc treats it as a non-module and refuses a literal
// import. A non-literal specifier skips static resolution while vitest still
// resolves it at runtime.
const STREAM_MODULE = "../scripts/stream";

type Handler = (event: unknown) => void;

// connectTail/connectRunner construct an EventSource; stub it so no network
// is attempted and the handlers attach harmlessly. `dispatch` lets tests fire
// server events into the captured listeners.
class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = 2; // CLOSED
  private readonly handlers: Map<string, Handler[]>;

  constructor(url: string) {
    this.url = url;
    this.handlers = new Map();
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  close(): void {
    this.readyState = 2;
  }

  dispatch(type: string, data: string): void {
    const event = new MessageEvent(type, { data });
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

// Builds a runner transcript with an optional number of queued-prompt cards.
const runnerTranscript = (sessionId: string, queued = 0): string => {
  const cards = Array.from(
    { length: queued },
    (_, i) =>
      `<article class="message prompt queued-prompt">queued-${i}</article>`,
  ).join("");
  const queue =
    queued > 0
      ? `<div id="queued-prompts">${cards}<button class="clear-queue-btn">Clear</button></div>`
      : "";
  return (
    `<div class="detail-inner" data-session-id="${sessionId}" data-run-status="running">` +
    '<div id="messages"></div>' +
    '<div id="live-output" class="live-output"></div>' +
    queue +
    '<form class="prompt-bar">' +
    '<p class="status-hint running" aria-live="polite">Running…</p>' +
    '<textarea name="prompt" class="prompt-input" rows="2"></textarea>' +
    "</form>" +
    "</div>"
  );
};

// JSDOM has no layout engine, so pin the scroll metrics so nearBottom is
// deterministic. With scrollHeight 10000 and clientHeight 600, scrollTop 0 is
// far from the bottom; scrollTop 9500 is within the 160px threshold.
const fixMetrics = (pane: Element): void => {
  Object.defineProperty(pane, "scrollHeight", {
    configurable: true,
    value: 10000,
  });
  Object.defineProperty(pane, "clientHeight", {
    configurable: true,
    value: 600,
  });
};

type Setup = { win: JSDOM["window"]; pane: HTMLElement };

const setup = (innerHtml: string): Setup => {
  MockEventSource.instances = [];
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main class="detail" id="detail-pane">${innerHtml}</main></body></html>`,
  );
  const doc = dom.window.document;
  const win = dom.window;
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("CustomEvent", win.CustomEvent);
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("MessageEvent", win.MessageEvent);
  vi.stubGlobal("localStorage", storage);
  const pane = doc.getElementById("detail-pane")!;
  fixMetrics(pane);
  return { win, pane };
};

const fireSwap = (win: JSDOM["window"], innerHtml: string): void => {
  const pane = document.getElementById("detail-pane")!;
  pane.innerHTML = innerHtml;
  fixMetrics(pane);
  document.body.dispatchEvent(
    new win.CustomEvent("htmx:afterSwap", {
      detail: { target: { id: "detail-pane" } },
    }),
  );
};

describe("live-stream prompt-card reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not dismiss queued cards for replayed (pre-connect) prompts", async () => {
    const { win } = setup(runnerTranscript("s1", 2));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1", 2));
    const source = MockEventSource.instances[0]!;

    // 1 prompt had already started before connecting (startedCount baseline).
    source.dispatch(
      "status",
      JSON.stringify({ status: "running", pendingCount: 2, startedCount: 1 }),
    );
    // The replayed prompt card must NOT dismiss a still-queued card.
    source.dispatch("prompt", "<article>replay</article>");

    expect(document.querySelectorAll(".queued-prompt")).toHaveLength(2);
  });

  it("dismisses a queued card only for a genuine new transition", async () => {
    const { win } = setup(runnerTranscript("s1", 2));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1", 2));
    const source = MockEventSource.instances[0]!;

    source.dispatch(
      "status",
      JSON.stringify({ status: "running", pendingCount: 2, startedCount: 1 }),
    );
    // First prompt is the replay (startedCount baseline) — no dismiss.
    source.dispatch("prompt", "<article>replay</article>");
    // Second prompt is a new queued→running transition — dismiss one card.
    source.dispatch("prompt", "<article>new</article>");

    expect(document.querySelectorAll(".queued-prompt")).toHaveLength(1);
  });
});

describe("live-stream scroll behaviour", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not yank to the bottom when the reader has scrolled up", async () => {
    const { win, pane } = setup(runnerTranscript("s1"));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1"));
    // Reader scrolled up to read history (far from the bottom).
    pane.scrollTop = 0;
    const source = MockEventSource.instances[0]!;

    source.dispatch("line", "<div>new line</div>");

    expect(pane.scrollTop).toBe(0);
  });
});

describe("run-completion draft preservation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("preserves an unsent follow-up across the done-triggered re-render", async () => {
    const initial = runnerTranscript("s1");
    const { win, pane } = setup(initial);
    await import(STREAM_MODULE);
    fireSwap(win, initial);
    const textarea =
      document.querySelector<HTMLTextAreaElement>(".prompt-input")!;
    textarea.value = "my unsent draft";
    const source = MockEventSource.instances[0]!;

    // Run completes: the done handler captures the draft before the swap.
    source.dispatch("done", "completed");
    // Simulate the htmx re-render landing: idle transcript with a fresh
    // (empty) textarea, then the afterSwap that re-runs init().
    fireSwap(
      win,
      '<div class="detail-inner" data-session-id="s1">' +
        '<div id="messages"></div>' +
        '<form class="prompt-bar">' +
        '<textarea name="prompt" class="prompt-input" rows="2"></textarea>' +
        "</form>" +
        "</div>",
    );

    const restored = pane.querySelector<HTMLTextAreaElement>(".prompt-input")!;
    expect(restored.value).toBe("my unsent draft");
  });
});

describe("terminal status hint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("clears the stale Running hint on a terminal status", async () => {
    const { win } = setup(runnerTranscript("s1"));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1"));
    const source = MockEventSource.instances[0]!;

    source.dispatch("status", JSON.stringify({ status: "completed" }));

    const hint = document.querySelector(".status-hint")!;
    expect(hint.textContent).toBe("");
    expect(hint.className).toBe("status-hint");
  });
});
