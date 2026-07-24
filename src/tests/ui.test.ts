import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunner, DEFAULT_RUNNER_CONFIG } from "../runner/index.js";
import { createApp } from "../server/index.js";

const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_tokens INTEGER,
  provider_name TEXT,
  user_set_name BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMP
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tokens INTEGER,
  metadata_json TEXT
);
`;

let db: DatabaseSync;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-ui-"));
  db = new DatabaseSync(join(dir, "sessions.db"));
  db.exec(SCHEMA);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const uiScript = async (): Promise<string> =>
  (
    await createApp(db, createRunner(DEFAULT_RUNNER_CONFIG)).request(
      "/assets/ui.js",
    )
  ).text();

// The compiled ui.js is a classic side-effect script; run it in a JSDOM
// context (mirroring the rename test) so we can assert on the live DOM.
const runUi = async (html: string) => {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  vm.runInNewContext(await uiScript(), {
    document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLPreElement: dom.window.HTMLPreElement,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (cb: () => void) => cb(),
    navigator: { clipboard: { writeText: async () => undefined } },
    setTimeout: dom.window.setTimeout,
  });
  document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  return document;
};

describe("ui enhancements (client script)", () => {
  it("wraps <pre> blocks in a copy-enabled container", async () => {
    const document = await runUi(
      '<!DOCTYPE html><html><body><main id="detail-pane"><pre><code>const x = 1;</code></pre></main></body></html>',
    );
    const wrap = document.querySelector(".code-block");
    expect(wrap).not.toBeNull();
    expect(wrap?.querySelector("pre code")?.textContent).toBe("const x = 1;");
    const btn = document.querySelector<HTMLButtonElement>(".copy-code-btn");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-label")).toBe("Copy code");
  });

  it("syncs the document title to the viewed session", async () => {
    const document = await runUi(
      '<!DOCTYPE html><html><body><main id="detail-pane"><h2 class="session-title">Build the thing</h2></main></body></html>',
    );
    // Server <title> covers full page loads; the client re-derives it on
    // htmx detail-pane swaps (where the <title> isn't part of the payload).
    const pane = document.getElementById("detail-pane");
    const win = document.defaultView;
    if (win === null) throw new Error("no defaultView");
    document.body.dispatchEvent(
      new win.CustomEvent("htmx:afterSwap", { detail: { target: pane } }),
    );
    expect(document.title).toBe("Build the thing \u2014 Goose Log Viewer");
  });

  it("mounts a hidden scroll-to-latest button", async () => {
    const document = await runUi(
      '<!DOCTYPE html><html><body><main id="detail-pane"><p>short</p></main></body></html>',
    );
    const btn = document.getElementById("scroll-latest");
    expect(btn).not.toBeNull();
    expect(btn?.hidden).toBe(true);
  });

  it("toggles between the sidebar and detail panes on mobile", async () => {
    const document = await runUi(
      '<!DOCTYPE html><html><body><div class="app" data-mobile-pane="detail"><nav class="mobile-pane-toggle"><button type="button" class="mobile-pane-btn" data-pane="sidebar" aria-pressed="false">Sessions</button><button type="button" class="mobile-pane-btn" data-pane="detail" aria-pressed="false">Detail</button></nav><main id="detail-pane"></main></div></body></html>',
    );
    const app = document.querySelector(".app");
    const detailBtn = document.querySelector<HTMLButtonElement>(
      '.mobile-pane-btn[data-pane="detail"]',
    );
    const sidebarBtn = document.querySelector<HTMLButtonElement>(
      '.mobile-pane-btn[data-pane="sidebar"]',
    );
    // Init syncs the active tab to the server-rendered default (detail).
    expect(app?.getAttribute("data-mobile-pane")).toBe("detail");
    expect(detailBtn?.getAttribute("aria-pressed")).toBe("true");
    expect(sidebarBtn?.getAttribute("aria-pressed")).toBe("false");
    // Tapping "Sessions" flips to the sidebar pane.
    sidebarBtn?.click();
    expect(app?.getAttribute("data-mobile-pane")).toBe("sidebar");
    expect(sidebarBtn?.getAttribute("aria-pressed")).toBe("true");
    expect(detailBtn?.getAttribute("aria-pressed")).toBe("false");
    // Opening a session swaps #detail-pane and should surface it again.
    const win = document.defaultView;
    if (win === null) throw new Error("no defaultView");
    document.body.dispatchEvent(
      new win.CustomEvent("htmx:afterSwap", {
        detail: { target: document.getElementById("detail-pane") },
      }),
    );
    expect(app?.getAttribute("data-mobile-pane")).toBe("detail");
  });
});
