import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sidebar.ts is a side-effect-only browser script (no exports, loaded as a
// classic <script>), so tsc treats it as a non-module and refuses a literal
// import. A non-literal specifier skips static resolution while vitest still
// resolves it at runtime.
const SIDEBAR_MODULE = "../scripts/sidebar";

type Handler = (event: unknown) => void;

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState: number;
  private readonly handlers: Map<string, Handler[]>;

  constructor(url: string) {
    this.url = url;
    this.readyState = MockEventSource.CONNECTING;
    this.handlers = new Map();
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

// Matches the sidebar's `instanceof MessageEvent` guard for test dispatch.
class MockMessageEvent {
  readonly data: string;

  constructor(_type: string, init: { data: string }) {
    this.data = init.data;
  }
}

describe("status feed reconnection", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("EventSource", MockEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reconnects after a permanent (CLOSED) close", async () => {
    await import(SIDEBAR_MODULE);
    expect(MockEventSource.instances).toHaveLength(1);

    const feed = MockEventSource.instances[0];
    feed.readyState = MockEventSource.CLOSED;
    feed.dispatch("error");

    // Capped exponential backoff starts at 1s.
    await vi.advanceTimersByTimeAsync(999);
    expect(MockEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe("/events/status");
  });

  it("does not reconnect on a transient (CONNECTING) drop", async () => {
    await import(SIDEBAR_MODULE);
    const feed = MockEventSource.instances[0];

    // readyState stays CONNECTING — EventSource auto-reconnects itself.
    feed.readyState = MockEventSource.CONNECTING;
    feed.dispatch("error");

    await vi.advanceTimersByTimeAsync(60000);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("grows the backoff when successive closes arrive without an open", async () => {
    await import(SIDEBAR_MODULE);
    const first = MockEventSource.instances[0];
    first.readyState = MockEventSource.CLOSED;
    first.dispatch("error");

    // Base delay (1s) elapses -> a second feed appears.
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockEventSource.instances).toHaveLength(2);

    const second = MockEventSource.instances[1];
    second.readyState = MockEventSource.CLOSED;
    second.dispatch("error");

    // Next delay doubles to 2s; advancing only 1s must not reconnect yet.
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockEventSource.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockEventSource.instances).toHaveLength(3);
  });
});

describe("status feed session names", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <div class="session-item" data-session-id="alpha">
          <span class="session-name">CLI session</span>
        </div>
      </body></html>`,
    );
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("MessageEvent", MockMessageEvent);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("updates the sidebar name when a rename event arrives", async () => {
    await import(SIDEBAR_MODULE);
    const feed = MockEventSource.instances[0];
    feed.dispatch(
      "rename",
      new MockMessageEvent("rename", {
        data: JSON.stringify({ sessionId: "alpha", name: "Build the project" }),
      }),
    );
    expect(document.querySelector(".session-name")?.textContent).toBe(
      "Build the project",
    );
  });

  it("renders an empty name as (unnamed)", async () => {
    await import(SIDEBAR_MODULE);
    const feed = MockEventSource.instances[0];
    feed.dispatch(
      "rename",
      new MockMessageEvent("rename", {
        data: JSON.stringify({ sessionId: "alpha", name: "" }),
      }),
    );
    expect(document.querySelector(".session-name")?.textContent).toBe(
      "(unnamed)",
    );
  });

  it("ignores a rename for an unknown session", async () => {
    await import(SIDEBAR_MODULE);
    const feed = MockEventSource.instances[0];
    feed.dispatch(
      "rename",
      new MockMessageEvent("rename", {
        data: JSON.stringify({ sessionId: "missing", name: "Nope" }),
      }),
    );
    expect(document.querySelector(".session-name")?.textContent).toBe(
      "CLI session",
    );
  });
});

describe("meta refresh on run completion", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <div id="session-list">
          <div class="session-item" data-session-id="alpha"></div>
        </div>
      </body></html>`,
    );
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("MessageEvent", MockMessageEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("re-fetches a session's meta once its run completes", async () => {
    const ajax = vi.fn();
    vi.stubGlobal("htmx", { ajax });
    await import(SIDEBAR_MODULE);
    const feed = MockEventSource.instances[0];
    feed.dispatch(
      "status",
      new MockMessageEvent("status", {
        data: JSON.stringify({ sessionId: "alpha", status: "done" }),
      }),
    );
    expect(ajax).toHaveBeenCalledWith("GET", "/sessions/alpha/sidebar-meta", {
      target: "#session-list",
      swap: "none",
    });
  });

  it("leaves the meta untouched while a session is still running", async () => {
    const ajax = vi.fn();
    vi.stubGlobal("htmx", { ajax });
    await import(SIDEBAR_MODULE);
    const feed = MockEventSource.instances[0];
    feed.dispatch(
      "status",
      new MockMessageEvent("status", {
        data: JSON.stringify({ sessionId: "alpha", status: "running" }),
      }),
    );
    expect(ajax).not.toHaveBeenCalled();
  });

  it("skips sessions not present in the sidebar", async () => {
    const ajax = vi.fn();
    vi.stubGlobal("htmx", { ajax });
    await import(SIDEBAR_MODULE);
    const feed = MockEventSource.instances[0];
    feed.dispatch(
      "status",
      new MockMessageEvent("status", {
        data: JSON.stringify({ sessionId: "missing", status: "done" }),
      }),
    );
    expect(ajax).not.toHaveBeenCalled();
  });
});

describe("unread sessions", () => {
  const makeStorage = () => {
    const store = new Map<string, string>();
    return {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    };
  };

  let storage: ReturnType<typeof makeStorage>;

  const LIST = `
    <div id="session-list">
      <div class="session-item" data-session-id="alpha">
        <a class="session-link"><span class="session-name">Alpha</span></a>
      </div>
      <div class="session-item" data-session-id="beta">
        <a class="session-link"><span class="session-name">Beta</span></a>
      </div>
    </div>`;

  // sidebar.ts now reads localStorage and listens for htmx:afterSwap, neither
  // of which the existing harness stubs, so this block sets up its own DOM.
  const setup = (bodyHtml: string): void => {
    storage = makeStorage();
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>${bodyHtml}</body></html>`,
    );
    const win = dom.window;
    MockEventSource.instances = [];
    vi.stubGlobal("document", win.document);
    // sidebar.ts type-guards with `instanceof Element/HTMLElement`, and the
    // node test env has no DOM globals, so expose jsdom's constructors.
    vi.stubGlobal("Element", win.Element);
    vi.stubGlobal("HTMLElement", win.HTMLElement);
    vi.stubGlobal("HTMLInputElement", win.HTMLInputElement);
    vi.stubGlobal("CustomEvent", win.CustomEvent);
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("MessageEvent", MockMessageEvent);
    vi.stubGlobal("localStorage", storage);
  };

  const dispatchStatus = (sessionId: string, status: string): void =>
    MockEventSource.instances[0].dispatch(
      "status",
      new MockMessageEvent("status", {
        data: JSON.stringify({ sessionId, status }),
      }),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("marks a finishing non-open session as unread", async () => {
    setup(LIST);
    await import(SIDEBAR_MODULE);
    dispatchStatus("alpha", "done");
    expect(
      document
        .querySelector<HTMLElement>(".session-item[data-session-id='alpha']")
        ?.classList.contains("unread"),
    ).toBe(true);
    expect(JSON.parse(storage.getItem("glv-unread") ?? "[]")).toEqual([
      "alpha",
    ]);
  });

  it("leaves the currently-open session unmarked", async () => {
    setup(
      `<div id="detail-pane"><div data-session-id="alpha"></div></div>${LIST}`,
    );
    await import(SIDEBAR_MODULE);
    dispatchStatus("alpha", "done");
    expect(
      document
        .querySelector<HTMLElement>(".session-item[data-session-id='alpha']")
        ?.classList.contains("unread"),
    ).toBe(false);
    expect(storage.getItem("glv-unread")).toBeNull();
  });

  it("clears unread when a session link is clicked", async () => {
    setup(LIST);
    await import(SIDEBAR_MODULE);
    dispatchStatus("alpha", "done");
    expect(JSON.parse(storage.getItem("glv-unread") ?? "[]")).toEqual([
      "alpha",
    ]);
    document
      .querySelector<HTMLElement>(
        ".session-item[data-session-id='alpha'] .session-link",
      )
      ?.click();
    expect(
      document
        .querySelector<HTMLElement>(".session-item[data-session-id='alpha']")
        ?.classList.contains("unread"),
    ).toBe(false);
    expect(JSON.parse(storage.getItem("glv-unread") ?? "[]")).toEqual([]);
  });

  it("restores unread styling from localStorage on load", async () => {
    setup(LIST);
    storage.setItem("glv-unread", JSON.stringify(["beta"]));
    await import(SIDEBAR_MODULE);
    expect(
      document
        .querySelector<HTMLElement>(".session-item[data-session-id='beta']")
        ?.classList.contains("unread"),
    ).toBe(true);
    expect(
      document
        .querySelector<HTMLElement>(".session-item[data-session-id='alpha']")
        ?.classList.contains("unread"),
    ).toBe(false);
  });

  it("prunes unread ids no longer present in the DOM", async () => {
    setup(LIST);
    storage.setItem("glv-unread", JSON.stringify(["alpha", "gone"]));
    await import(SIDEBAR_MODULE);
    expect(JSON.parse(storage.getItem("glv-unread") ?? "[]")).toEqual([
      "alpha",
    ]);
  });

  it("re-applies unread classes after an htmx swap of #session-list", async () => {
    setup(LIST);
    storage.setItem("glv-unread", JSON.stringify(["alpha"]));
    await import(SIDEBAR_MODULE);
    const item = document.querySelector<HTMLElement>(
      ".session-item[data-session-id='alpha']",
    );
    item?.classList.remove("unread");
    expect(item?.classList.contains("unread")).toBe(false);
    document.dispatchEvent(
      new CustomEvent("htmx:afterSwap", {
        detail: { target: { id: "session-list" } },
      }),
    );
    expect(item?.classList.contains("unread")).toBe(true);
  });
});
