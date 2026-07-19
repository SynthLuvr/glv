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
