import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

// stream.ts is a side-effect-only browser script (no exports, loaded as a
// classic <script>), so tsc treats it as a non-module and refuses a literal
// import. A non-literal specifier skips static resolution while vitest still
// resolves it at runtime.
const STREAM_MODULE = "../scripts/stream";

type Handler = (event: unknown) => void;

// connect() constructs an EventSource; stub it so no network is attempted and
// the handlers attach harmlessly. `dispatch` lets tests fire server events
// into the captured listeners.
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
    `<div class="detail-inner" data-session-id="${sessionId}" data-run-status="running" data-cursor="0">` +
    '<div id="messages"></div>' +
    '<div id="live-tail" class="live-tail"></div>' +
    queue +
    '<form class="prompt-bar" data-prompt-bar>' +
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

describe("unified event stream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("connects to the unified /events endpoint with the cursor", async () => {
    const { win } = setup(runnerTranscript("s1"));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1"));
    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe("/sessions/s1/events?cursor=0");
  });
});

describe("prompt-card dismissal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("dismisses a queued card for each prompt event", async () => {
    const { win } = setup(runnerTranscript("s1", 2));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1", 2));
    const source = MockEventSource.instances[0]!;

    // Each prompt event represents a genuine queued→running transition.
    source.dispatch("prompt", "<article>first</article>");
    expect(document.querySelectorAll(".queued-prompt")).toHaveLength(1);

    source.dispatch("prompt", "<article>second</article>");
    expect(document.querySelectorAll(".queued-prompt")).toHaveLength(0);
  });

  it("appends the prompt card to the live tail", async () => {
    const { win } = setup(runnerTranscript("s1"));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1"));
    const source = MockEventSource.instances[0]!;

    source.dispatch(
      "prompt",
      "<article class='stream-line'>new prompt</article>",
    );
    expect(document.getElementById("live-tail")!.innerHTML).toContain(
      "new prompt",
    );
  });
});

describe("preview scroll behaviour", () => {
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

    source.dispatch("preview", "<div>new line</div>");

    expect(pane.scrollTop).toBe(0);
  });
});

describe("messages reconciliation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("appends catch-up entries on the messages event", async () => {
    const { win } = setup(runnerTranscript("s1"));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1"));
    const source = MockEventSource.instances[0]!;

    const html =
      '<article class="message output" data-msg-index="0">hello</article>';
    source.dispatch(
      "messages",
      JSON.stringify({ entries: [{ index: 0, html }], cursor: 1 }),
    );

    expect(document.getElementById("messages")!.innerHTML).toContain("hello");
  });

  it("skips entries already present (idempotent reconnect)", async () => {
    const { win } = setup(runnerTranscript("s1"));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1"));
    const source = MockEventSource.instances[0]!;

    const html =
      '<article class="message output" data-msg-index="0">hello</article>';
    const payload = JSON.stringify({
      entries: [{ index: 0, html }],
      cursor: 1,
    });
    source.dispatch("messages", payload);
    source.dispatch("messages", payload); // reconnect re-send

    expect(
      document.querySelectorAll("#messages [data-msg-index='0']"),
    ).toHaveLength(1);
  });
});

describe("preview-clear", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("empties the live tail and removes the active prompt card", async () => {
    const { win } = setup(runnerTranscript("s1"));
    await import(STREAM_MODULE);
    fireSwap(
      win,
      `<div class="detail-inner" data-session-id="s1" data-run-status="running" data-cursor="0">` +
        '<div id="messages"></div>' +
        '<article class="message prompt submitted-prompt" data-active-prompt>my prompt</article>' +
        '<div id="live-tail" class="live-tail"><div>preview line</div></div>' +
        '<form class="prompt-bar" data-prompt-bar><textarea class="prompt-input"></textarea></form>' +
        "</div>",
    );
    const source = MockEventSource.instances[0]!;

    source.dispatch("preview-clear", "");

    expect(document.getElementById("live-tail")!.innerHTML).toBe("");
    expect(document.querySelector("[data-active-prompt]")).toBeNull();
  });
});

describe("prompt-bar draft preservation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("preserves an unsent draft across a prompt-bar status swap", async () => {
    const { win } = setup(runnerTranscript("s1"));
    await import(STREAM_MODULE);
    fireSwap(win, runnerTranscript("s1"));
    const textarea =
      document.querySelector<HTMLTextAreaElement>(".prompt-input")!;
    textarea.value = "my unsent draft";
    const source = MockEventSource.instances[0]!;

    // Run completes: the status transition captures the draft before the
    // targeted prompt-bar swap.
    source.dispatch("status", JSON.stringify({ status: "completed" }));

    // Simulate the htmx prompt-bar swap landing (idle form replaces the busy
    // form), then the afterSwap that restores the captured draft.
    const bar = document.querySelector("[data-prompt-bar]")!;
    bar.outerHTML =
      '<form class="prompt-bar" data-prompt-bar>' +
      '<textarea name="prompt" class="prompt-input" rows="2"></textarea>' +
      '<button class="send-btn">Send</button>' +
      "</form>";
    document.body.dispatchEvent(
      new win.CustomEvent("htmx:afterSwap", {
        detail: { target: { tagName: "FORM" } },
      }),
    );

    const restored =
      document.querySelector<HTMLTextAreaElement>(".prompt-input")!;
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
