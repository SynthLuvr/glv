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

type ClipboardLike = {
  writeText: (text: string) => Promise<void>;
};

// The compiled ui.js is a classic side-effect script; run it in a JSDOM
// context (mirroring the rename test) so we can assert on the live DOM.
// The clipboard mock is injectable so copy-button tests can spy on writes
// and verify the execCommand fallback when the async API is absent.
const runUi = async (
  html: string,
  opts: {
    clipboard?: ClipboardLike | undefined;
    execCommand?: ((cmd: string) => boolean) | undefined;
  } = {},
) => {
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
    navigator: { clipboard: opts.clipboard },
    setTimeout: dom.window.setTimeout,
  });
  if (opts.execCommand !== undefined)
    document.execCommand =
      opts.execCommand as unknown as typeof document.execCommand;
  document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  return document;
};

const COPY_MD_HTML =
  '<!DOCTYPE html><html><body><main id="detail-pane">' +
  '<button type="button" class="copy-md-btn" data-md="Hello **world**">' +
  '<svg class="icon-copy"></svg><svg class="icon-check"></svg>' +
  "</button></main></body></html>";

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

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

  it("copies markdown to the clipboard when the copy-md button is clicked", async () => {
    const writes: string[] = [];
    const document = await runUi(COPY_MD_HTML, {
      clipboard: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    });
    document.querySelector<HTMLButtonElement>(".copy-md-btn")?.click();
    await flush();
    expect(writes).toEqual(["Hello **world**"]);
    expect(
      document.querySelector(".copy-md-btn")?.classList.contains("copied"),
    ).toBe(true);
  });

  it("falls back to execCommand when the Clipboard API is unavailable", async () => {
    // navigator.clipboard is undefined over plain HTTP on a non-localhost
    // origin — the regression that silently broke copy buttons.
    const copied: string[] = [];
    const document = await runUi(COPY_MD_HTML, {
      clipboard: undefined,
      execCommand: () => {
        copied.push("ok");
        return true;
      },
    });
    document.querySelector<HTMLButtonElement>(".copy-md-btn")?.click();
    await flush();
    expect(copied).toEqual(["ok"]);
    expect(
      document.querySelector(".copy-md-btn")?.classList.contains("copied"),
    ).toBe(true);
  });
});
