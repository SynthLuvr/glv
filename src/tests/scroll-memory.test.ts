import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// stream.ts is a side-effect-only browser script (no exports, loaded as a
// classic <script>), so tsc treats it as a non-module and refuses a literal
// import. A non-literal specifier skips static resolution while vitest still
// resolves it at runtime.
const STREAM_MODULE = "../scripts/stream";

type Handler = (event: unknown) => void;

// connectTail/connectRunner construct an EventSource; stub it so no network
// is attempted and the handlers attach harmlessly.
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
}

const transcript = (sessionId: string, runStatus?: string): string => {
  const attr = runStatus !== undefined ? ` data-run-status="${runStatus}"` : "";
  return `<div class="detail-inner" data-session-id="${sessionId}"${attr}><div id="messages"></div></div>`;
};

// JSDOM has no layout engine, so scrollHeight/clientHeight are always 0. Pin
// them so the restore logic can be exercised deterministically.
const fixMetrics = (pane: Element, scrollHeight: number): void => {
  Object.defineProperty(pane, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(pane, "clientHeight", {
    configurable: true,
    value: 600,
  });
};

type Setup = { win: JSDOM["window"]; store: Map<string, string> };

const setup = (sessionId: string, runStatus?: string): Setup => {
  MockEventSource.instances = [];
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main class="detail" id="detail-pane">${transcript(
      sessionId,
      runStatus,
    )}</main></body></html>`,
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
  // The htmx swap handlers guard with `instanceof CustomEvent`; route that to
  // JSDOM's constructor so dispatched events pass the check.
  vi.stubGlobal("CustomEvent", win.CustomEvent);
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("localStorage", storage);
  fixMetrics(doc.getElementById("detail-pane")!, 10000);
  return { win, store };
};

const fireSwap = (
  win: JSDOM["window"],
  sessionId: string,
  runStatus?: string,
): void => {
  const pane = document.getElementById("detail-pane")!;
  pane.innerHTML = transcript(sessionId, runStatus);
  fixMetrics(pane, 10000);
  document.body.dispatchEvent(
    new win.CustomEvent("htmx:afterSwap", {
      detail: { target: { id: "detail-pane" } },
    }),
  );
};

const fireBeforeSwap = (win: JSDOM["window"]): void => {
  document.body.dispatchEvent(
    new win.CustomEvent("htmx:beforeSwap", {
      detail: { target: { id: "detail-pane" } },
    }),
  );
};

describe("scroll-position memory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("restores a saved offset when revisiting a session", async () => {
    const { win, store } = setup("abc");
    store.set("glv:scroll:abc", "5000");
    await import(STREAM_MODULE);
    fireSwap(win, "abc");

    expect(document.getElementById("detail-pane")!.scrollTop).toBe(5000);
  });

  it("defaults to the bottom for an active run with no saved offset", async () => {
    const { win } = setup("xyz", "running");
    await import(STREAM_MODULE);
    fireSwap(win, "xyz", "running");

    expect(document.getElementById("detail-pane")!.scrollTop).toBe(10000);
  });

  it("defaults to the top for an idle session with no saved offset", async () => {
    const { win } = setup("idle");
    await import(STREAM_MODULE);
    fireSwap(win, "idle");

    expect(document.getElementById("detail-pane")!.scrollTop).toBe(0);
  });

  it("saves the offset before navigating away from a session", async () => {
    const { win, store } = setup("abc");
    await import(STREAM_MODULE);
    fireSwap(win, "abc");
    document.getElementById("detail-pane")!.scrollTop = 3333;

    fireBeforeSwap(win);

    expect(store.get("glv:scroll:abc")).toBe("3333");
  });

  it("persists the offset on scroll so a reload still remembers it", async () => {
    const { win, store } = setup("abc");
    await import(STREAM_MODULE);
    fireSwap(win, "abc");
    const pane = document.getElementById("detail-pane")!;
    pane.scrollTop = 7777;
    pane.dispatchEvent(new win.Event("scroll"));

    await vi.advanceTimersByTimeAsync(150);

    expect(store.get("glv:scroll:abc")).toBe("7777");
  });

  it("ignores a non-numeric stored value", async () => {
    const { win, store } = setup("abc");
    store.set("glv:scroll:abc", "not-a-number");
    await import(STREAM_MODULE);
    fireSwap(win, "abc");

    // Falls through to the idle default (top).
    expect(document.getElementById("detail-pane")!.scrollTop).toBe(0);
  });

  it("does not restore on a non-session view (e.g. new session)", async () => {
    const { win } = setup("abc");
    await import(STREAM_MODULE);
    // Replace the transcript with content that has no session id.
    document.getElementById("detail-pane")!.innerHTML =
      '<div class="new-session"><h2>Start</h2></div>';
    document.body.dispatchEvent(
      new win.CustomEvent("htmx:afterSwap", {
        detail: { target: { id: "detail-pane" } },
      }),
    );

    expect(document.getElementById("detail-pane")!.scrollTop).toBe(0);
  });
});
