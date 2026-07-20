import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitRunner } from "../git.js";
import type { ProcessResult, SpawnFn } from "../runner/index.js";
import {
  createRunner,
  DEFAULT_RUNNER_CONFIG,
  getHandle,
  makeRunnerConfig,
} from "../runner/index.js";
import { createApp, expandHome, listHomeDirs } from "../server/index.js";

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

type SessionSeed = {
  id: string;
  name: string;
  type: string;
  dir: string;
  updated: string;
  tokens: number | null;
  provider: string | null;
};

const SESSIONS: readonly SessionSeed[] = [
  {
    id: "alpha",
    name: "Alpha Session",
    type: "user",
    dir: "/tmp/alpha",
    updated: "2026-07-13 10:00:00",
    tokens: 1234,
    provider: "anthropic",
  },
  {
    id: "beta",
    name: "Beta Session",
    type: "user",
    dir: "/tmp/beta",
    updated: "2026-07-13 09:00:00",
    tokens: 50,
    provider: null,
  },
  {
    id: "gamma",
    name: "Gamma Build",
    type: "user",
    dir: "/tmp/gamma",
    updated: "2026-07-13 08:00:00",
    tokens: 999,
    provider: "openai",
  },
  {
    id: "silent",
    name: "Silent Run",
    type: "hidden",
    dir: "/tmp/silent",
    updated: "2026-07-13 11:00:00",
    tokens: 10,
    provider: null,
  },
];

const insertSessions = (
  db: DatabaseSync,
  sessions: readonly SessionSeed[],
): void => {
  const stmt = db.prepare(
    "INSERT INTO sessions (id, name, session_type, working_dir, updated_at, total_tokens, provider_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const s of sessions)
    stmt.run(s.id, s.name, s.type, s.dir, s.updated, s.tokens, s.provider);
};

type MessageSeed = {
  sessionId: string;
  role: string;
  content: string;
  ts: number;
};

const MESSAGES: readonly MessageSeed[] = [
  {
    sessionId: "alpha",
    role: "user",
    content: JSON.stringify([{ type: "text", text: "What is goose?" }]),
    ts: 1,
  },
  {
    sessionId: "alpha",
    role: "assistant",
    content: JSON.stringify([
      { type: "thinking", thinking: "hmm" },
      { type: "toolRequest", id: "1" },
    ]),
    ts: 2,
  },
  {
    sessionId: "alpha",
    role: "user",
    content: JSON.stringify([{ type: "toolResponse", id: "1" }]),
    ts: 3,
  },
  {
    sessionId: "alpha",
    role: "assistant",
    content: JSON.stringify([{ type: "text", text: "Goose is an agent" }]),
    ts: 4,
  },
  // gamma exercises the richer content shapes (markdown, thinking, tools).
  {
    sessionId: "gamma",
    role: "user",
    content: JSON.stringify([{ type: "text", text: "Run the build." }]),
    ts: 10,
  },
  {
    sessionId: "gamma",
    role: "assistant",
    content: JSON.stringify([
      { type: "thinking", thinking: "I will run the shell command." },
      {
        type: "toolRequest",
        id: "call_1",
        toolCall: {
          status: "success",
          value: { name: "shell", arguments: { command: "pnpm build" } },
        },
        _meta: { goose_extension: "developer" },
      },
    ]),
    ts: 11,
  },
  {
    sessionId: "gamma",
    role: "user",
    content: JSON.stringify([
      {
        type: "toolResponse",
        id: "call_1",
        toolResult: {
          status: "success",
          value: {
            content: [{ type: "text", text: "Build succeeded" }],
            isError: false,
          },
        },
      },
    ]),
    ts: 12,
  },
  {
    sessionId: "gamma",
    role: "assistant",
    content: JSON.stringify([
      {
        type: "text",
        text: "## Done\n\nThe build **succeeded**:\n\n```\nno errors\n```",
      },
    ]),
    ts: 13,
  },
  {
    sessionId: "gamma",
    role: "assistant",
    content: JSON.stringify([
      {
        type: "toolRequest",
        id: "call_2",
        toolCall: {
          status: "success",
          value: { name: "read_file", arguments: { path: "/missing" } },
        },
      },
    ]),
    ts: 14,
  },
  {
    sessionId: "gamma",
    role: "user",
    content: JSON.stringify([
      {
        type: "toolResponse",
        id: "call_2",
        toolResult: {
          status: "error",
          value: {
            content: [{ type: "text", text: "File not found" }],
            isError: true,
          },
        },
      },
    ]),
    ts: 15,
  },
];

const insertMessages = (
  db: DatabaseSync,
  messages: readonly MessageSeed[],
): void => {
  const stmt = db.prepare(
    "INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)",
  );
  for (const m of messages) stmt.run(m.sessionId, m.role, m.content, m.ts);
};

const seed = (db: DatabaseSync): void => {
  db.exec(SCHEMA);
  insertSessions(db, SESSIONS);
  insertMessages(db, MESSAGES);
};

let db: DatabaseSync;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-web-it-"));
  db = new DatabaseSync(join(dir, "sessions.db"));
  seed(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const makeApp = (spawn?: SpawnFn): ReturnType<typeof createApp> =>
  createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn));

const renderRoot = async (): Promise<string> =>
  (await makeApp().request("/")).text();

describe("web viewer GET /", () => {
  it("lists user sessions, excluding hidden ones", async () => {
    const html = await renderRoot();
    expect(html).toContain("Alpha Session");
    expect(html).toContain("Beta Session");
    expect(html).not.toContain("Silent Run");
  });

  it("surfaces session metadata in the sidebar cards", async () => {
    const html = await renderRoot();
    expect(html).toContain("/tmp/alpha");
    expect(html).toContain("session-item");
    expect(html).toContain("run-indicator");
  });

  it("renders session names as links to the detail route", async () => {
    const html = await renderRoot();
    expect(html).toContain('href="/sessions/alpha"');
    expect(html).toContain('href="/sessions/beta"');
  });

  it("shows the new-session form as the detail landing", async () => {
    const html = await renderRoot();
    expect(html).toContain("New Session");
    expect(html).toContain('name="prompt"');
    expect(html).toContain('name="working_dir"');
  });

  it("shows an empty state when there are no sessions", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "glv-web-empty-"));
    const emptyDb = new DatabaseSync(join(emptyDir, "sessions.db"));
    emptyDb.exec(SCHEMA);
    try {
      const res = await createApp(
        emptyDb,
        createRunner(DEFAULT_RUNNER_CONFIG),
      ).request("/");
      expect(await res.text()).toContain("No sessions found.");
    } finally {
      emptyDb.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("wires the sidebar with htmx to swap only the detail pane", async () => {
    const html = await renderRoot();
    expect(html).toContain('<script src="/assets/htmx.min.js"');
    expect(html).toContain('id="detail-pane"');
    expect(html).toContain('hx-target="#detail-pane"');
    expect(html).toContain('hx-push-url="true"');
    // each card keeps a real href (progressive enhancement) plus hx-get
    expect(html).toContain('href="/sessions/alpha" hx-get="/sessions/alpha"');
  });

  it("does not rewrite the URL when the out-of-band sidebar-meta loader fires", async () => {
    // #session-list carries hx-push-url="true" so detail-pane swaps update the
    // address bar. The sidebar-meta OOB loader is a child of #session-list, so
    // without an explicit override it inherits that and rewrites the URL to
    // /sessions/sidebar-meta on every page load.
    const html = await renderRoot();
    const dom = new JSDOM(html);
    const loader = dom.window.document.querySelector(".sidebar-meta-loader");
    expect(loader).not.toBeNull();
    expect(loader?.getAttribute("hx-push-url")).toBe("false");
  });

  it("does not force the detail pane to scroll to the top on navigation", async () => {
    // Scroll position is now remembered per session by stream.js; forcing
    // scrollTop:top here would override the restored offset.
    const html = await renderRoot();
    expect(html).toContain('id="session-list"');
    expect(html).toContain('hx-swap="innerHTML"');
    expect(html).not.toContain("scrollTop:top");
  });

  it("adds a selection checkbox to each session card", async () => {
    const html = await renderRoot();
    expect(html).toContain('class="session-check"');
    expect(html).toContain('name="id" value="alpha"');
    expect(html).toContain('name="id" value="beta"');
  });

  it("renders a bulk action bar for archiving the selection", async () => {
    const html = await renderRoot();
    expect(html).toContain('id="bulk-bar"');
    expect(html).toContain('hx-post="/sessions/archive"');
    expect(html).toContain('hx-include="closest #session-list"');
  });
});

const renderSession = async (
  id: string,
): Promise<{ status: number; html: string }> => {
  const res = await makeApp().request(`/sessions/${id}`);
  return { status: res.status, html: await res.text() };
};

describe("web viewer GET /sessions/:id", () => {
  it("renders the transcript with prompts and outputs", async () => {
    const { status, html } = await renderSession("alpha");
    expect(status).toBe(200);
    expect(html).toContain("PROMPT");
    expect(html).toContain("What is goose?");
    expect(html).toContain("OUTPUT");
    expect(html).toContain("Goose is an agent");
  });

  it("shows session metadata in the transcript header", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain("Alpha Session");
    expect(html).toContain("/tmp/alpha");
  });

  it("renders a lazy git-info hook in the session meta row", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain("/sessions/alpha/git-info");
    expect(html).toContain('hx-trigger="load"');
  });

  it("keeps the sidebar and highlights the selected session", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain("Alpha Session");
    expect(html).toContain("Beta Session");
    expect(html).toContain('class="session-item selected"');
  });

  it("returns 404 with a message for an unknown session", async () => {
    const { status, html } = await renderSession("missing");
    expect(status).toBe(404);
    expect(html).toContain("Session not found");
    expect(html).toContain("missing");
  });

  it("renders an archive button in the transcript header", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain('class="archive-btn"');
    expect(html).toContain('hx-post="/sessions/alpha/archive"');
  });

  it("lays out the archive button beside the title so it stays clickable", async () => {
    const { html } = await renderSession("alpha");
    // The button must share a flex row with the title rather than float as
    // an absolute overlay that the full-width title container paints over
    // (which left only a sliver of the button clickable).
    const top = html.indexOf('class="session-header-top"');
    const title = html.indexOf('id="session-title-wrap"');
    const btn = html.indexOf('class="archive-btn"');
    expect(top).toBeGreaterThan(-1);
    expect(title).toBeGreaterThan(top);
    expect(btn).toBeGreaterThan(title);
  });
});

describe("transcript readability (markdown, thinking, tools)", () => {
  it("renders assistant text as markdown", async () => {
    const { html } = await renderSession("gamma");
    expect(html).toContain("<h2>Done</h2>");
    expect(html).toContain("<strong>succeeded</strong>");
    expect(html).toContain("no errors");
    expect(html).toContain("copy-md-btn");
  });

  it("adds a copy-as-markdown button to user prompts", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain("What is goose?");
    expect(html).toContain("▸ PROMPT");
    // Prompts render as plain text, not parsed markdown, yet stay copyable.
    expect(html).toContain("copy-md-btn");
    expect(html).toContain('data-md="What is goose?"');
    expect(html).not.toContain("<strong>");
  });

  it("surfaces reasoning in collapsible thinking blocks", async () => {
    const { html } = await renderSession("gamma");
    expect(html).toContain("Thinking");
    expect(html).toContain("I will run the shell command.");
  });

  it("renders tool calls with name, extension and arguments", async () => {
    const { html } = await renderSession("gamma");
    expect(html).toContain("shell");
    expect(html).toContain("developer");
    expect(html).toContain("pnpm build");
    expect(html).toContain("<details");
  });

  it("renders tool results", async () => {
    const { html } = await renderSession("gamma");
    expect(html).toContain("Build succeeded");
  });

  it("highlights error tool results", async () => {
    const { html } = await renderSession("gamma");
    expect(html).toContain("Error result");
    expect(html).toContain("File not found");
    expect(html).toContain("is-error");
  });

  it("tags tool-response messages as tool activity, not prompts", async () => {
    const { html } = await renderSession("gamma");
    expect(html).toContain("⟳ TOOL");
  });
});

// A request carrying the `HX-Request: true` header is an htmx-driven click.
// The server answers with a *partial* (detail fragment + an out-of-band sidebar
// update) rather than the full document, so only the right pane is re-rendered.
const renderHtmx = async (
  path: string,
): Promise<{ status: number; html: string }> => {
  const res = await makeApp().request(path, {
    headers: { "HX-Request": "true" },
  });
  return { status: res.status, html: await res.text() };
};

describe("web viewer htmx asset", () => {
  it("serves the vendored htmx library as JavaScript", async () => {
    const res = await makeApp().request("/assets/htmx.min.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("htmx");
    expect(body.length).toBeGreaterThan(1000);
  });
});

describe("web viewer static assets", () => {
  it("references the stylesheet and client script in the document", async () => {
    const res = await makeApp().request("/");
    const html = await res.text();
    expect(html).toContain('rel="stylesheet" href="/assets/app.css"');
    expect(html).toContain('<script src="/assets/sidebar.js"');
  });

  it("serves the stylesheet as CSS", async () => {
    const res = await makeApp().request("/assets/app.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const body = await res.text();
    expect(body).toContain("--color-accent");
    expect(body).toContain(".session-item");
  });

  it("serves the sidebar client script as JavaScript", async () => {
    const res = await makeApp().request("/assets/sidebar.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain(".session-check");
    expect(body.length).toBeGreaterThan(100);
  });

  it("serves the markdown-copy client script as JavaScript", async () => {
    const res = await makeApp().request("/assets/markdown-copy.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("copy-md-btn");
  });
});

describe("web viewer htmx partials (HX-Request)", () => {
  it("returns only the transcript fragment for a session", async () => {
    const { status, html } = await renderHtmx("/sessions/alpha");
    expect(status).toBe(200);
    expect(html).not.toContain("<html");
    expect(html).not.toContain("Goose Sessions");
    expect(html).toContain("What is goose?");
    expect(html).toContain("Goose is an agent");
  });

  it("returns only the transcript without re-rendering the sidebar", async () => {
    const { html } = await renderHtmx("/sessions/alpha");
    expect(html).toContain("What is goose?");
    // navigation must not swap the sidebar, otherwise the bulk selection is lost
    expect(html).not.toContain('id="session-list"');
    expect(html).not.toContain('hx-swap-oob="true"');
    expect(html).not.toContain("Beta Session");
  });

  it("refreshes the sidebar out-of-band when ?sidebar=1 is set", async () => {
    const { html } = await renderHtmx("/sessions/alpha?sidebar=1");
    expect(html).toContain("What is goose?");
    // The stream's done handler re-renders with this flag so the sidebar
    // picks up a name goose set mid-run rather than the stale placeholder.
    expect(html).toContain('hx-swap-oob="true"');
    expect(html).toContain('id="session-list"');
    expect(html).toContain("Alpha Session");
  });

  it("returns only the new-session form fragment for the root", async () => {
    const { html } = await renderHtmx("/");
    expect(html).not.toContain("<html");
    expect(html).toContain("New Session");
    expect(html).toContain('name="prompt"');
    expect(html).not.toContain('hx-swap-oob="true"');
  });

  it("returns a 404 fragment for an unknown session", async () => {
    const { status, html } = await renderHtmx("/sessions/missing");
    expect(status).toBe(404);
    expect(html).toContain("Session not found");
    expect(html).not.toContain("<html");
  });
});

// Archiving mutates the database, so these tests run against an isolated copy
// to avoid leaking state into the read-only suites above.
describe("web viewer archive", () => {
  let archiveDb: DatabaseSync;
  let archiveDir: string;

  beforeAll(() => {
    archiveDir = mkdtempSync(join(tmpdir(), "glv-web-archive-"));
    archiveDb = new DatabaseSync(join(archiveDir, "sessions.db"));
    seed(archiveDb);
  });

  afterAll(() => {
    archiveDb.close();
    rmSync(archiveDir, { recursive: true, force: true });
  });

  const archive = async (
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; html: string }> => {
    const res = await createApp(
      archiveDb,
      createRunner(DEFAULT_RUNNER_CONFIG),
    ).request(path, init);
    return { status: res.status, html: await res.text() };
  };

  it("archives a single session from the transcript button (htmx)", async () => {
    const { status, html } = await archive("/sessions/alpha/archive", {
      method: "POST",
      headers: { "HX-Request": "true" },
    });
    expect(status).toBe(200);
    expect(html).toContain("New Session");
    expect(html).not.toContain("Alpha Session");
    expect(html).toContain("Beta Session");
  });

  it("marks the session as archived in the database", () => {
    const rows = archiveDb
      .prepare(
        "SELECT id FROM sessions WHERE id = ? AND archived_at IS NOT NULL",
      )
      .all("alpha");
    expect(rows).toHaveLength(1);
  });

  it("archives a bulk selection submitted as repeated id fields", async () => {
    const form = new URLSearchParams();
    form.append("id", "beta");
    form.append("id", "gamma");
    const { status, html } = await archive("/sessions/archive", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(status).toBe(200);
    expect(html).toContain('id="session-list"');
    expect(html).not.toContain("Beta Session");
    expect(html).not.toContain("Gamma Build");
  });

  it("hides every user session once they are all archived", async () => {
    const { status, html } = await archive("/");
    expect(status).toBe(200);
    expect(html).toContain("No sessions found.");
  });
});

describe("web viewer rename", () => {
  let renameDb: DatabaseSync;
  let renameDir: string;

  beforeAll(() => {
    renameDir = mkdtempSync(join(tmpdir(), "glv-web-rename-"));
    renameDb = new DatabaseSync(join(renameDir, "sessions.db"));
    seed(renameDb);
  });

  afterAll(() => {
    renameDb.close();
    rmSync(renameDir, { recursive: true, force: true });
  });

  const app = (): ReturnType<typeof createApp> =>
    createApp(renameDb, createRunner(DEFAULT_RUNNER_CONFIG));

  const rename = async (
    path: string,
    fields: Record<string, string>,
    htmx = false,
  ): Promise<{ status: number; html: string }> => {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await app().request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(htmx ? { "HX-Request": "true" } : {}),
      },
      body: form.toString(),
    });
    return { status: res.status, html: await res.text() };
  };

  const isNameRow = (
    v: unknown,
  ): v is { name: string; user_set_name: number } =>
    typeof v === "object" &&
    v !== null &&
    "name" in v &&
    typeof v.name === "string" &&
    "user_set_name" in v &&
    typeof v.user_set_name === "number";

  const row = (id: string): { name: string; user_set_name: number } => {
    const result = renameDb
      .prepare("SELECT name, user_set_name FROM sessions WHERE id = ?")
      .get(id);
    if (!isNameRow(result)) throw new Error(`no row for session ${id}`);
    return result;
  };

  it("renders inline rename controls in the transcript header", async () => {
    const html = await (await app().request("/sessions/alpha")).text();
    expect(html).toContain('class="rename-pencil"');
    expect(html).toContain('data-action="rename"');
    expect(html).toContain('hx-post="/sessions/alpha/rename"');
    expect(html).toContain('id="session-title-wrap"');
  });

  it("renders a rename pencil on each sidebar card", async () => {
    const html = await (await app().request("/")).text();
    expect(html).toContain("rename-pencil");
  });

  it("renders the sidebar rename editor as an overlay over each card", async () => {
    const html = await (await app().request("/")).text();
    expect(html).toContain("rename-wrap is-sidebar");
    expect(html).toContain('class="rename-form"');
    expect(html).toContain('class="rename-input"');
    expect(html).toContain('class="rename-confirm"');
    expect(html).toContain('class="rename-cancel"');
    expect(html).toContain('hx-target="#session-list"');
  });

  it("serves the rename client script and references it in the document", async () => {
    const doc = await (await app().request("/")).text();
    expect(doc).toContain('<script src="/assets/rename.js"');
    const res = await app().request("/assets/rename.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it("renames from the header, persists it, and refreshes the sidebar OOB", async () => {
    const { status, html } = await rename(
      "/sessions/alpha/rename",
      { name: "My Alpha", from: "header" },
      true,
    );
    expect(status).toBe(200);
    expect(html).toContain("My Alpha");
    expect(html).toContain('id="session-title-wrap"');
    expect(html).toContain('hx-swap-oob="true"');
    expect(row("alpha")).toEqual({ name: "My Alpha", user_set_name: 1 });
  });

  it("trims whitespace around the submitted name", async () => {
    await rename(
      "/sessions/beta/rename",
      { name: "  Beta Renamed  ", from: "header" },
      true,
    );
    expect(row("beta").name).toBe("Beta Renamed");
  });

  it("clears the custom name when the value is blank", async () => {
    await rename(
      "/sessions/alpha/rename",
      { name: "   ", from: "header" },
      true,
    );
    expect(row("alpha")).toEqual({ name: "", user_set_name: 0 });
  });

  it("re-renders the sidebar list when renamed from the sidebar", async () => {
    const { status, html } = await rename(
      "/sessions/gamma/rename",
      { name: "Gamma Renamed", from: "sidebar" },
      true,
    );
    expect(status).toBe(200);
    expect(html).toContain('id="session-list"');
    expect(html).toContain("Gamma Renamed");
  });

  it("returns 404 for an unknown session", async () => {
    const { status, html } = await rename("/sessions/missing/rename", {
      name: "x",
      from: "header",
    });
    expect(status).toBe(404);
    expect(html).toContain("Session not found");
  });

  // Regression: the action-less form POSTs to the current URL (a 404) when
  // requestSubmit() isn't intercepted by htmx; Enter must route through htmx.
  it("submits the rename through htmx on Enter (no native navigation)", async () => {
    const html = await (await app().request("/sessions/alpha")).text();
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const input = document.querySelector<HTMLInputElement>(
      "#session-title-wrap input.rename-input",
    );
    const form = input?.form ?? null;
    expect(form).toBeInstanceOf(dom.window.HTMLFormElement);
    if (!(form instanceof dom.window.HTMLFormElement))
      throw new Error("rename form missing");

    let nativeSubmits = 0;
    form.requestSubmit = (): void => {
      nativeSubmits += 1;
    };
    const htmxCalls: unknown[] = [];
    const fakeHtmx = {
      trigger: (elt: unknown, event: string): void => {
        htmxCalls.push([elt, event]);
      },
    };

    const renameJs = await (await app().request("/assets/rename.js")).text();
    vm.runInNewContext(renameJs, {
      document,
      HTMLInputElement: dom.window.HTMLInputElement,
      Element: dom.window.Element,
      htmx: fakeHtmx,
    });

    input?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(nativeSubmits).toBe(0);
    expect(htmxCalls).toEqual([[form, "submit"]]);
  });
});

// === M2: prompt runner HTTP API tests ===

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type MockSpawnState = {
  spawn: SpawnFn;
  invocations: Array<{
    binary: string;
    args: string[];
    opts: { stdin: string; cwd: string };
  }>;
  killCalls: Array<{ pid: number; signal?: string }>;
};

const createMockSpawn = (
  lines: string[],
  opts: { delayMs?: number; exitCode?: number } = {},
): MockSpawnState => {
  const invocations: MockSpawnState["invocations"] = [];
  const killCalls: MockSpawnState["killCalls"] = [];
  let pidCounter = 30000;

  const spawn: SpawnFn = (binary, args, spawnOpts) => {
    invocations.push({ binary, args, opts: spawnOpts });
    const pid = ++pidCounter;
    const local = { killed: false };
    let resolveExit!: (r: ProcessResult) => void;
    const exit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });

    const stdout = (async function* () {
      for (const line of lines) {
        if (local.killed) return;
        if (opts.delayMs !== undefined) await sleep(opts.delayMs);
        yield line;
      }
      if (!local.killed) resolveExit({ exitCode: opts.exitCode ?? 0 });
    })();

    const kill = (signal?: string) => {
      if (local.killed) return;
      local.killed = true;
      killCalls.push({ pid, signal });
      resolveExit({ exitCode: null, signal: signal ?? "SIGTERM" });
    };

    return { pid, kill, stdout, exit };
  };

  return { spawn, invocations, killCalls };
};

const postForm = async (
  app: ReturnType<typeof createApp>,
  path: string,
  fields: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; html: string }> => {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...extraHeaders,
    },
    body: form.toString(),
  });
  return { status: res.status, html: await res.text() };
};

describe("prompt bar in transcript", () => {
  it("renders a prompt input bar in every session view", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain('class="prompt-bar"');
    expect(html).toContain('name="prompt"');
    expect(html).toContain('placeholder="Ask goose…"');
  });

  it("shows a Send button when idle", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain('class="send-btn"');
    expect(html).toContain(">Send<");
    expect(html).not.toContain("stop-btn");
  });

  it("wires the prompt form to the POST endpoint via htmx", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain('hx-post="/sessions/alpha/prompt"');
    expect(html).toContain('hx-target="#detail-pane"');
    expect(html).toContain('hx-swap="innerHTML"');
  });

  it("shows a prompt bar even for sessions with no messages", async () => {
    const { html } = await renderSession("beta");
    expect(html).toContain("This session has no messages.");
    expect(html).toContain('class="prompt-bar"');
  });
});

describe("POST /sessions/:id/prompt", () => {
  it("submits a prompt and shows the running state with Queue + Stop buttons", async () => {
    const { spawn } = createMockSpawn(["line1"], { delayMs: 500 });
    const app = makeApp(spawn);
    const { status, html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "hello goose",
    });
    expect(status).toBe(200);
    expect(html).toContain("hello goose");
    expect(html).toContain("queue-btn");
    expect(html).toContain("Stop");
    expect(html).not.toContain(">Send<");
  });

  it("pipes the prompt via stdin to goose in the session working dir", async () => {
    const { spawn, invocations } = createMockSpawn(["x"], {
      delayMs: 500,
    });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "test prompt" });
    expect(invocations).toHaveLength(1);
    expect(invocations[0].binary).toBe("goose");
    expect(invocations[0].opts.stdin).toBe("test prompt");
    expect(invocations[0].opts.cwd).toBe("/tmp/alpha");
    expect(invocations[0].args).toContain("-i");
    expect(invocations[0].args).toContain("-");
    expect(invocations[0].args).not.toContain("-t");
  });

  it("returns 404 for a non-existent session", async () => {
    const { spawn } = createMockSpawn([]);
    const app = makeApp(spawn);
    const { status, html } = await postForm(app, "/sessions/missing/prompt", {
      prompt: "hello",
    });
    expect(status).toBe(404);
    expect(html).toContain("Session not found");
  });

  it("does not start a run for an empty prompt", async () => {
    const { spawn, invocations } = createMockSpawn(["x"]);
    const app = makeApp(spawn);
    const { html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "  ",
    });
    expect(invocations).toHaveLength(0);
    expect(html).toContain("send-btn");
    expect(html).not.toContain("stop-btn");
  });

  it("shows queue position when the concurrency cap is reached", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = createApp(
      db,
      createRunner(makeRunnerConfig(1, "goose"), spawn),
    );
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    const { html } = await postForm(app, "/sessions/beta/prompt", {
      prompt: "second",
    });
    expect(html).toContain("Queued");
    expect(html).toContain("position");
  });

  it("queues the prompt instead of starting a second run", async () => {
    const { spawn, invocations } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "second" });
    // Only the first prompt started; the second was queued.
    expect(invocations).toHaveLength(1);
    expect(invocations[0].opts.stdin).toBe("first");
  });
});

describe("follow-up prompt queuing", () => {
  it("shows a queued-prompt card when a follow-up is submitted", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    const { html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "do more",
    });
    expect(html).toContain("queued-prompt");
    expect(html).toContain("do more");
    expect(html).toContain("Clear all queued");
  });

  it("shows multiple queued-prompt cards in FIFO order", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "second" });
    const { html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "third",
    });
    expect(html).toContain("second");
    expect(html).toContain("third");
    const firstIdx = html.indexOf("second");
    const secondIdx = html.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("shows queue and stop buttons when busy", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    const { html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "second",
    });
    expect(html).toContain("queue-btn");
    expect(html).toContain("stop-btn");
    expect(html).not.toContain(">Send<");
  });

  it("shows the pending count in the running status hint", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "second" });
    const { html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "third",
    });
    expect(html).toContain("2 prompts queued next");
  });

  it("keeps the running prompt visible after queuing", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "original" });
    const { html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "follow-up",
    });
    // The running prompt should still be shown as SubmittedPrompt.
    expect(html).toContain("submitted-prompt");
    expect(html).toContain("original");
  });
});

describe("POST /sessions/:id/queue/cancel", () => {
  it("clears all pending prompts", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "second" });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "third" });

    const { html } = await postForm(app, "/sessions/alpha/queue/cancel", {});
    expect(html).not.toContain("queued-prompt");
    expect(html).not.toContain("Clear all queued");
    // The running prompt should still be active.
    expect(html).toContain("Running");
  });

  it("returns 404 for a non-existent session", async () => {
    const { spawn } = createMockSpawn([]);
    const app = makeApp(spawn);
    const { status, html } = await postForm(
      app,
      "/sessions/missing/queue/cancel",
      {},
    );
    expect(status).toBe(404);
    expect(html).toContain("Session not found");
  });
});

describe("GET /sessions/:id/stream (SSE)", () => {
  it("returns 404 for a non-existent session", async () => {
    const { spawn } = createMockSpawn([]);
    const app = makeApp(spawn);
    const res = await app.request("/sessions/missing/stream");
    expect(res.status).toBe(404);
  });

  it("sends a done event for an idle session with no run", async () => {
    const { spawn } = createMockSpawn([]);
    const app = makeApp(spawn);
    const res = await app.request("/sessions/alpha/stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: done");
    expect(text).toContain("idle");
  });

  it("streams output lines live as SSE events", async () => {
    const { spawn } = createMockSpawn(["delta1", "delta2"], { delayMs: 80 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).toContain("event: line");
    expect(text).toContain("delta1");
    expect(text).toContain("delta2");
    expect(text).toContain("event: done");
    expect(text).toContain("complete");
  });

  it("catches up via accumulated lines when the run already finished", async () => {
    const { spawn } = createMockSpawn(["done1", "done2"]);
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    // Let the fast mock finish before connecting.
    await sleep(150);

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).toContain("done1");
    expect(text).toContain("done2");
    expect(text).toContain("event: done");
    expect(text).toContain("completed");
  });

  it("reports an error status when goose exits non-zero", async () => {
    const { spawn } = createMockSpawn(["partial"], { exitCode: 42 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
    await sleep(150);

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).toContain("event: done");
    expect(text).toContain("data: error");
  });

  it("emits a running status when a queued run starts", async () => {
    // Concurrency of one so the second prompt queues behind the first.
    const { spawn } = createMockSpawn(["a", "b"], { delayMs: 300 });
    const app = createApp(
      db,
      createRunner(makeRunnerConfig(1, "goose"), spawn),
    );
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/beta/prompt", { prompt: "second" });

    const res = await app.request("/sessions/beta/stream");
    const text = await res.text();

    const queuedAt = text.indexOf('"status":"queued"');
    const runningAt = text.indexOf('"status":"running"');
    expect(queuedAt).toBeGreaterThanOrEqual(0);
    expect(runningAt).toBeGreaterThan(queuedAt);
    expect(text).toContain("event: done");
  });

  it("includes pendingCount in status events", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 50 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "second" });

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).toContain("pendingCount");
    expect(text).toContain('"pendingCount":1');
  });

  it("emits prompt events for chained runs", async () => {
    const { spawn } = createMockSpawn(["line1"], { delayMs: 50 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "second" });

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).toContain("event: prompt");
    expect(text).toContain("second");
    expect(text).toContain("event: done");
  });

  it("accumulates lines across chained runs in the stream", async () => {
    const { spawn } = createMockSpawn(["a", "b"], { delayMs: 30 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "second" });

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    // Each run produces lines a, b — both runs' output should appear.
    const firstA = text.indexOf("a");
    const firstB = text.indexOf("b");
    const secondA = text.indexOf("a", firstB + 1);
    expect(firstA).toBeGreaterThanOrEqual(0);
    expect(firstB).toBeGreaterThan(firstA);
    expect(secondA).toBeGreaterThan(firstB);
  });
});

describe("POST /sessions/:id/stop", () => {
  it("stops a running session and returns to idle state", async () => {
    const { spawn, killCalls } = createMockSpawn(["l1", "l2"], {
      delayMs: 500,
    });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const res = await app.request("/sessions/alpha/stop", { method: "POST" });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0].signal).toBe("SIGINT");
    expect(html).toContain("send-btn");
    expect(html).not.toContain("stop-btn");
  });

  it("is a no-op when no run is active", async () => {
    const { spawn, killCalls } = createMockSpawn([]);
    const app = makeApp(spawn);
    const res = await app.request("/sessions/alpha/stop", { method: "POST" });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(killCalls).toHaveLength(0);
    expect(html).toContain("send-btn");
  });

  it("returns 404 for a non-existent session", async () => {
    const { spawn } = createMockSpawn([]);
    const app = makeApp(spawn);
    const res = await app.request("/sessions/missing/stop", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

// === M3: interactive streaming UI ===

describe("M3: streaming assets & layout", () => {
  it("references the stream client script in the document", async () => {
    const res = await makeApp().request("/");
    const html = await res.text();
    expect(html).toContain('<script src="/assets/stream.js"');
  });

  it("serves the stream client script as JavaScript", async () => {
    const res = await makeApp().request("/assets/stream.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("EventSource");
    expect(body).toContain("htmx:afterSwap");
  });
});

describe("M3: transcript streaming attributes", () => {
  it("does not include a live-output container when idle", async () => {
    const { html } = await renderSession("alpha");
    expect(html).not.toContain('id="live-output"');
    expect(html).not.toContain("data-run-status");
  });

  it("includes data attributes and live-output when a run is active", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    const { html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "hello",
    });
    expect(html).toContain('data-session-id="alpha"');
    expect(html).toContain('data-run-status="running"');
    expect(html).toContain('id="live-output"');
  });

  it("omits live-output when the run has completed", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
    await sleep(150);

    const res = await app.request("/sessions/alpha/stop", { method: "POST" });
    const html = await res.text();
    expect(html).not.toContain('id="live-output"');
  });
});

describe("M3: SSE stream renders HTML fragments", () => {
  it("renders stream-json lines as HTML in the SSE stream", async () => {
    const jsonLine = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "Live output" }],
    });
    const { spawn } = createMockSpawn([jsonLine], { delayMs: 80 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).toContain("event: line");
    expect(text).toContain("Live output");
    expect(text).toContain("stream-line");
    expect(text).toContain("OUTPUT");
  });

  it("renders non-JSON lines as raw text blocks", async () => {
    const { spawn } = createMockSpawn(["plain text"], { delayMs: 80 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).toContain("stream-raw");
    expect(text).toContain("plain text");
  });

  it("skips stream-json lines without renderable content", async () => {
    const metaLine = JSON.stringify({
      type: "session.header",
      session_id: "abc",
    });
    const { spawn } = createMockSpawn([metaLine]);
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
    await sleep(150);

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).not.toContain("event: line");
    expect(text).toContain("event: done");
  });
});

// === M4: polish & robustness ===

describe("M4: error persistence on re-render", () => {
  it("shows the error banner on GET after a run errors", async () => {
    const { spawn } = createMockSpawn(["partial"], {
      exitCode: 1,
      delayMs: 50,
    });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
    await sleep(300);

    const res = await app.request("/sessions/alpha");
    const html = await res.text();
    expect(html).toContain("status-hint error");
    expect(html).toContain("goose exited with code 1");
    // the input is re-enabled (pane left in a usable state)
    expect(html).toContain("send-btn");
    expect(html).not.toContain("stop-btn");
  });

  it("does not show live-output for a completed run handle", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
    await sleep(200);

    const res = await app.request("/sessions/alpha");
    const html = await res.text();
    expect(html).not.toContain('id="live-output"');
    expect(html).toContain("send-btn");
  });

  it("does not duplicate the prompt bar for a terminal handle", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
    await sleep(200);

    const res = await app.request("/sessions/alpha");
    const html = await res.text();
    expect(html.match(/class="prompt-bar"/g)).toHaveLength(1);
  });
});

describe("M4: SSE done carries the real terminal status", () => {
  it("sends 'completed' (not a generic marker) on success", async () => {
    const { spawn } = createMockSpawn(["delta1"], { delayMs: 80 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).toContain("event: done");
    expect(text).toContain("data: completed");
  });

  it("sends 'stopped' when a run was stopped", async () => {
    const { spawn } = createMockSpawn(["l1", "l2"], { delayMs: 200 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
    await app.request("/sessions/alpha/stop", { method: "POST" });

    const res = await app.request("/sessions/alpha/stream");
    const text = await res.text();

    expect(text).toContain("event: done");
    expect(text).toContain("data: stopped");
  });
});

describe("M4: external runner injection", () => {
  it("uses a caller-supplied runner so shutdown cleanup can reach it", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const app = createApp(db, runner);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    // The runner — not a private one inside createApp — holds the handle.
    expect(getHandle(runner, "alpha")).toBeDefined();
    expect(getHandle(runner, "alpha")?.prompt).toBe("hello");
  });
});

describe("M4: stream client reconnect deduplication", () => {
  it("clears live output on EventSource (re)open to avoid duplicates", async () => {
    const res = await makeApp().request("/assets/stream.js");
    const body = await res.text();
    // An 'open' listener empties #live-output before catch-up lines arrive.
    expect(body).toContain('"open"');
    expect(body).toContain('innerHTML=""');
  });
});

// === M5: live-tail for externally-driven sessions ===

describe("M5: transcript message container", () => {
  it("wraps rendered messages in a #messages container for live appending", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain('id="messages"');
    expect(html).toContain("What is goose?");
  });
});

describe("M5: stream client live-tail wiring", () => {
  it("connects the tail endpoint and appends new messages", async () => {
    const res = await makeApp().request("/assets/stream.js");
    const body = await res.text();
    // The tail URL suffix and the SSE event name survive minification as
    // string literals, confirming the client wires the live-tail stream.
    expect(body).toContain("/tail");
    expect(body).toContain('"append"');
    expect(body).toContain("nearBottom");
  });
});

// === M6: live-tail polish (Phase 2) ===

describe("M6: live-tail header metadata hooks", () => {
  it("tags the updatable header chips with stable ids", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain('id="meta-updated"');
  });

  it("tags each rendered message with a stable data-msg-index", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain("data-msg-index");
  });
});

describe("M6: stream client live-tail polish wiring", () => {
  it("handles replace and meta events", async () => {
    const res = await makeApp().request("/assets/stream.js");
    const body = await res.text();
    expect(body).toContain('"replace"');
    expect(body).toContain('"meta"');
    expect(body).toContain("insertMessageInOrder");
  });
});

describe("GET /sessions/:id/tail (SSE)", () => {
  it("returns 404 for a non-existent session", async () => {
    const { spawn } = createMockSpawn([]);
    const app = makeApp(spawn);
    const res = await app.request("/sessions/missing/tail");
    expect(res.status).toBe(404);
  });

  it("responds with an event-stream content type", async () => {
    const { spawn } = createMockSpawn([]);
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
      tailPollMs: 15,
      maxTailPolls: 2,
    });
    const res = await app.request("/sessions/alpha/tail");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.text();
  });

  it("emits no append events when nothing new is written", async () => {
    const { spawn } = createMockSpawn([]);
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
      tailPollMs: 15,
      maxTailPolls: 3,
    });
    const res = await app.request("/sessions/alpha/tail");
    const text = await res.text();
    expect(text).not.toContain("event: append");
  });

  it("emits a rename when an external writer renames the session", async () => {
    const renameDir = mkdtempSync(join(tmpdir(), "glv-tail-rename-"));
    const renameDb = new DatabaseSync(join(renameDir, "sessions.db"));
    seed(renameDb);
    const app = createApp(renameDb, createRunner(DEFAULT_RUNNER_CONFIG), {
      tailPollMs: 15,
      maxTailPolls: 8,
    });

    const res = await app.request("/sessions/alpha/tail");

    // Let the baseline settle before an external writer renames the session.
    await sleep(40);

    renameDb
      .prepare("UPDATE sessions SET name = ? WHERE id = ?")
      .run("Refactor the parser", "alpha");

    const text = await res.text();
    renameDb.close();
    rmSync(renameDir, { recursive: true, force: true });

    expect(text).toContain("event: rename");
    expect(text).toContain('"name":"Refactor the parser"');
  });

  it("streams newly appended messages, skipping the baseline", async () => {
    const tailDir = mkdtempSync(join(tmpdir(), "glv-tail-"));
    const tailDb = new DatabaseSync(join(tailDir, "sessions.db"));
    seed(tailDb);
    const app = createApp(tailDb, createRunner(DEFAULT_RUNNER_CONFIG), {
      tailPollMs: 15,
      maxTailPolls: 8,
    });

    const res = await app.request("/sessions/alpha/tail");
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Give the handler a beat to capture its baseline (alpha ships with 4
    // messages) before we append, mimicking an external writer.
    await sleep(40);

    tailDb
      .prepare(
        "INSERT INTO messages (session_id, role, content_json, " +
          "created_timestamp) VALUES (?, ?, ?, ?)",
      )
      .run(
        "alpha",
        "assistant",
        JSON.stringify([{ type: "text", text: "tail-update" }]),
        9999,
      );

    // Drain the bounded stream to completion.
    const text = await res.text();
    tailDb.close();
    rmSync(tailDir, { recursive: true, force: true });

    expect(text).toContain("event: append");
    expect(text).toContain("tail-update");
    expect(text).toContain("OUTPUT");
    // baseline rows are already in the DOM and must not be re-sent
    expect(text).not.toContain("What is goose?");
  });

  it("re-emits a message whose content was updated in place", async () => {
    const replaceDir = mkdtempSync(join(tmpdir(), "glv-replace-"));
    const replaceDb = new DatabaseSync(join(replaceDir, "sessions.db"));
    seed(replaceDb);
    const app = createApp(replaceDb, createRunner(DEFAULT_RUNNER_CONFIG), {
      tailPollMs: 15,
      maxTailPolls: 8,
    });

    const res = await app.request("/sessions/alpha/tail");

    // Let the baseline settle before editing an existing row in place,
    // mimicking a growing assistant turn.
    await sleep(40);

    replaceDb
      .prepare(
        "UPDATE messages SET content_json = ? " +
          "WHERE session_id = ? AND created_timestamp = ?",
      )
      .run(
        JSON.stringify([
          { type: "text", text: "Goose is an agent that builds things" },
        ]),
        "alpha",
        4,
      );

    const text = await res.text();
    replaceDb.close();
    rmSync(replaceDir, { recursive: true, force: true });

    expect(text).toContain("event: replace");
    expect(text).toContain("builds things");
    // an in-place edit must not also fire as a redundant append
    expect(text).not.toContain("event: append");
  });

  it("emits a meta event refreshing header counts after changes", async () => {
    const metaDir = mkdtempSync(join(tmpdir(), "glv-meta-"));
    const metaDb = new DatabaseSync(join(metaDir, "sessions.db"));
    seed(metaDb);
    const app = createApp(metaDb, createRunner(DEFAULT_RUNNER_CONFIG), {
      tailPollMs: 15,
      maxTailPolls: 8,
    });

    const res = await app.request("/sessions/alpha/tail");

    await sleep(40);

    metaDb.exec("BEGIN");
    metaDb
      .prepare(
        "INSERT INTO messages (session_id, role, content_json, " +
          "created_timestamp) VALUES (?, ?, ?, ?)",
      )
      .run(
        "alpha",
        "assistant",
        JSON.stringify([{ type: "text", text: "fresh-line" }]),
        9999,
      );
    metaDb
      .prepare(
        "UPDATE sessions SET updated_at = ?, total_tokens = ? WHERE id = ?",
      )
      .run("2026-07-13 12:00:00", 5678, "alpha");
    metaDb.exec("COMMIT");

    const text = await res.text();
    metaDb.close();
    rmSync(metaDir, { recursive: true, force: true });

    expect(text).toContain("event: meta");
  });

  it("emits a done event and terminates when the session is deleted", async () => {
    const delDir = mkdtempSync(join(tmpdir(), "glv-tail-del-"));
    const delDb = new DatabaseSync(join(delDir, "sessions.db"));
    seed(delDb);
    const app = createApp(delDb, createRunner(DEFAULT_RUNNER_CONFIG), {
      tailPollMs: 15,
      maxTailPolls: 8,
    });

    const res = await app.request("/sessions/alpha/tail");
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Let the handler capture its baseline and poll once before the session
    // is removed, then delete it mid-connection.
    await sleep(40);
    delDb.prepare("DELETE FROM sessions WHERE id = ?").run("alpha");

    const text = await res.text();
    delDb.close();
    rmSync(delDir, { recursive: true, force: true });

    // The handler must emit a terminal event and close rather than spinning
    // on an empty result set forever.
    expect(text).toContain("event: done");
    expect(text).toContain("deleted");
  });
});

describe("listHomeDirs", () => {
  it("lists only public top-level directories under home", () => {
    const home = mkdtempSync(join(tmpdir(), "glv-home-"));
    try {
      mkdirSync(join(home, "projects"));
      mkdirSync(join(home, "repos"));
      mkdirSync(join(home, ".config"));
      mkdirSync(join(home, ".cache"));
      writeFileSync(join(home, "notes.txt"), "x");

      expect(listHomeDirs(home)).toEqual([
        join(home, "projects"),
        join(home, "repos"),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns an empty list when home has no public directories", () => {
    const home = mkdtempSync(join(tmpdir(), "glv-home-empty-"));
    try {
      mkdirSync(join(home, ".secret"));
      expect(listHomeDirs(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("expandHome", () => {
  it("expands ~ to the home dir", () => {
    expect(expandHome("~", "/home/me")).toBe("/home/me");
  });

  it("expands ~/child to a joined path", () => {
    expect(expandHome("~/projects/app", "/home/me")).toBe(
      join("/home/me", "projects/app"),
    );
  });

  it("leaves an absolute path unchanged", () => {
    expect(expandHome("/etc/config", "/home/me")).toBe("/etc/config");
  });

  it("leaves a bare relative path unchanged", () => {
    expect(expandHome("repos/x", "/home/me")).toBe("repos/x");
  });
});

describe("M5: new session entry points", () => {
  it("renders the new-session form on GET /sessions/new", async () => {
    const res = await makeApp().request("/sessions/new");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("New Session");
    expect(html).toContain('name="prompt"');
    expect(html).toContain('name="working_dir"');
    expect(html).toContain("Start session");
  });

  it("pre-fills the working dir and lists selectable dirs in a datalist", async () => {
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG), {
      listDirs: () => ["/home/me/projects", "/home/me/repos"],
    });
    const res = await app.request("/sessions/new");
    const html = await res.text();
    expect(html).toContain('list="recent-dirs"');
    expect(html).toContain("<datalist");
    expect(html).toContain("/home/me/projects");
    expect(html).toContain("/home/me/repos");
  });

  it("pre-fills the working directory from a ?working_dir= query param", async () => {
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG));
    const dir = "/tmp/glv-prefill-target";
    const res = await app.request(
      `/sessions/new?working_dir=${encodeURIComponent(dir)}`,
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain(`value="${dir}"`);
  });

  it("does not shadow the /sessions/:id route (new is a literal)", async () => {
    // /sessions/new must hit the form, not a 404 "session not found".
    const res = await makeApp().request("/sessions/new");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("Session not found");
  });

  it("adds a + new-session button to the sidebar header", async () => {
    const html = await renderRoot();
    expect(html).toContain('class="new-session-btn"');
    expect(html).toContain('href="/sessions/new"');
    expect(html).toContain('hx-get="/sessions/new"');
  });

  it("shows a start-new-session CTA in the empty sidebar state", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "glv-web-emptycta-"));
    const emptyDb = new DatabaseSync(join(emptyDir, "sessions.db"));
    emptyDb.exec(SCHEMA);
    try {
      const res = await createApp(
        emptyDb,
        createRunner(DEFAULT_RUNNER_CONFIG),
      ).request("/");
      const html = await res.text();
      expect(html).toContain("No sessions found.");
      expect(html).toContain("Start a new session");
      expect(html).toContain('href="/sessions/new"');
    } finally {
      emptyDb.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("wires the new-session form to POST /sessions via htmx", async () => {
    const res = await makeApp().request("/sessions/new");
    const html = await res.text();
    expect(html).toContain('hx-post="/sessions"');
    expect(html).toContain('hx-target="#detail-pane"');
  });
});

// A spawn mock that simulates goose creating the session row early: when
// invoked it inserts a `user` session with the spawn's cwd as the working dir,
// then yields the given lines. This lets the server's DB poll discover the real
// id without running real goose.
type NewSessionSpawnState = MockSpawnState & { insertedIds: string[] };

const createNewSessionSpawn = (
  db: DatabaseSync,
  lines: string[],
  opts: { delayMs?: number; exitCode?: number } = {},
): NewSessionSpawnState => {
  const invocations: NewSessionSpawnState["invocations"] = [];
  const killCalls: NewSessionSpawnState["killCalls"] = [];
  const insertedIds: string[] = [];
  let pidCounter = 50000;
  let counter = 0;

  const spawn: SpawnFn = (binary, args, spawnOpts) => {
    invocations.push({ binary, args, opts: spawnOpts });
    const pid = ++pidCounter;
    const local = { killed: false };
    let resolveExit!: (r: ProcessResult) => void;
    const exit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });

    const id = `ns-${Date.now()}-${++counter}`;
    const name = `session-${counter}`;
    insertedIds.push(id);
    db.prepare(
      "INSERT INTO sessions (id, name, session_type, working_dir) " +
        "VALUES (?, ?, 'user', ?)",
    ).run(id, name, spawnOpts.cwd);

    const stdout = (async function* () {
      for (const line of lines) {
        if (local.killed) return;
        if (opts.delayMs !== undefined) await sleep(opts.delayMs);
        yield line;
      }
      if (!local.killed) resolveExit({ exitCode: opts.exitCode ?? 0 });
    })();

    const kill = (signal?: string) => {
      if (local.killed) return;
      local.killed = true;
      killCalls.push({ pid, signal });
      resolveExit({ exitCode: null, signal: signal ?? "SIGTERM" });
    };

    return { pid, kill, stdout, exit };
  };

  return { spawn, invocations, killCalls, insertedIds };
};

describe("M5: POST /sessions", () => {
  let newDb: DatabaseSync;
  let newDir: string;

  beforeAll(() => {
    newDir = mkdtempSync(join(tmpdir(), "glv-web-newsess-"));
    newDb = new DatabaseSync(join(newDir, "sessions.db"));
    seed(newDb);
  });

  afterAll(() => {
    newDb.close();
    rmSync(newDir, { recursive: true, force: true });
  });

  const makeNewApp = (
    spawn: SpawnFn,
    pollTimeoutMs = 5000,
  ): ReturnType<typeof createApp> =>
    createApp(newDb, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
      pollTimeoutMs,
    });

  it("starts a new session, shows the live transcript, and refreshes the sidebar", async () => {
    const { spawn, insertedIds } = createNewSessionSpawn(newDb, ["line1"], {
      delayMs: 200,
    });
    const app = makeNewApp(spawn);
    const { status, html } = await postForm(
      app,
      "/sessions",
      { prompt: "build the project", working_dir: newDir },
      { "HX-Request": "true" },
    );
    expect(status).toBe(200);
    expect(insertedIds).toHaveLength(1);
    expect(html).toContain(`data-session-id="${insertedIds[0]}"`);
    expect(html).toContain("data-run-status");
    expect(html).toContain("build the project");
    // sidebar refreshed out-of-band with the new session
    expect(html).toContain('hx-swap-oob="true"');
    expect(html).toContain("Stop");
  });

  it("re-renders the sidebar with goose's updated name after the run", async () => {
    const { spawn, insertedIds } = createNewSessionSpawn(newDb, ["line1"], {
      delayMs: 200,
    });
    const app = makeNewApp(spawn);
    // goose initially registers the session with a placeholder name.
    const { html: created } = await postForm(
      app,
      "/sessions",
      { prompt: "build it", working_dir: newDir },
      { "HX-Request": "true" },
    );
    const id = insertedIds[0];
    expect(created).toContain("session-1");

    // goose renames the session mid-run once it has conversational context.
    newDb
      .prepare("UPDATE sessions SET name = ? WHERE id = ?")
      .run("Build the project", id);

    // The stream's done handler re-renders GET /sessions/:id?sidebar=1, so
    // the sidebar must reflect the new name instead of the placeholder.
    const res = await app.request(`/sessions/${id}?sidebar=1`, {
      headers: { "HX-Request": "true" },
    });
    const html = await res.text();
    expect(html).toContain('hx-swap-oob="true"');
    // Scope to just this session's card. The shared test DB holds other
    // leftover "session-N" rows from sibling tests, and slicing to the end
    // of the document would wrongly include their names.
    const marker = `data-session-id="${id}"`;
    const start = html.lastIndexOf(marker);
    const next = html.indexOf(
      '<div class="session-item"',
      start + marker.length,
    );
    const item = next === -1 ? html.slice(start) : html.slice(start, next);
    expect(item).toContain(">Build the project<");
    expect(item).not.toContain("session-1");
  });

  it("expands ~ in the working dir before validating and spawning", async () => {
    const { spawn, invocations } = createNewSessionSpawn(newDb, ["x"], {
      delayMs: 200,
    });
    const app = makeNewApp(spawn);
    const { status } = await postForm(
      app,
      "/sessions",
      { prompt: "hello", working_dir: "~" },
      { "HX-Request": "true" },
    );
    expect(status).toBe(200);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].opts.cwd).toBe(homedir());
  });

  it("invokes goose run with the prompt on stdin (no -n name)", async () => {
    const { spawn, invocations } = createNewSessionSpawn(newDb, ["x"], {
      delayMs: 200,
    });
    const app = makeNewApp(spawn);
    await postForm(app, "/sessions", {
      prompt: "build the project",
      working_dir: newDir,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0].args).not.toContain("-n");
    expect(invocations[0].args).not.toContain("build the project");
    expect(invocations[0].args).not.toContain("--session-id");
    expect(invocations[0].args).not.toContain("-r");
    expect(invocations[0].opts.stdin).toBe("build the project");
    expect(invocations[0].opts.cwd).toBe(newDir);
  });

  it("re-keys the run from the temp key to the real session id", async () => {
    const { spawn, insertedIds } = createNewSessionSpawn(newDb, ["x"], {
      delayMs: 300,
    });
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const app = createApp(newDb, runner, { pollTimeoutMs: 5000 });
    await postForm(
      app,
      "/sessions",
      { prompt: "rekey check", working_dir: newDir },
      { "HX-Request": "true" },
    );
    const realId = insertedIds[0];
    // The handle is now reachable under the real id, not a temp key.
    const handle = getHandle(runner, realId);
    expect(handle).toBeDefined();
    expect(handle!.sessionId).toBe(realId);
    // No temporary keys remain in the registry.
    for (const key of runner.registry.keys()) expect(key).not.toMatch(/^tmp_/);
  });

  it("serializes concurrent submissions for the same dir without orphaning a run", async () => {
    const { spawn, insertedIds, killCalls } = createNewSessionSpawn(
      newDb,
      ["x"],
      { delayMs: 300 },
    );
    const runner = createRunner(DEFAULT_RUNNER_CONFIG, spawn);
    const app = createApp(newDb, runner, { pollTimeoutMs: 5000 });

    const [r1, r2] = await Promise.all([
      postForm(
        app,
        "/sessions",
        { prompt: "first", working_dir: newDir },
        { "HX-Request": "true" },
      ),
      postForm(
        app,
        "/sessions",
        { prompt: "second", working_dir: newDir },
        { "HX-Request": "true" },
      ),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(insertedIds).toHaveLength(2);
    const id1 = r1.html.match(/data-session-id="([^"]+)" data-run-status/)?.[1];
    const id2 = r2.html.match(/data-session-id="([^"]+)" data-run-status/)?.[1];
    expect(id1).not.toBe(id2);

    // Both real ids are tracked; no temp keys leak in the registry.
    expect(getHandle(runner, id1!)).toBeDefined();
    expect(getHandle(runner, id2!)).toBeDefined();
    for (const key of runner.registry.keys()) expect(key).not.toMatch(/^tmp_/);
    // No run was killed as a collision.
    expect(killCalls).toHaveLength(0);
  });

  it("does not match a pre-existing session in the same working dir", async () => {
    newDb
      .prepare(
        "INSERT INTO sessions (id, name, session_type, working_dir) " +
          "VALUES (?, ?, 'user', ?)",
      )
      .run("old-collision", "collide test", newDir);
    const { spawn, insertedIds } = createNewSessionSpawn(newDb, ["x"], {
      delayMs: 200,
    });
    const app = makeNewApp(spawn);
    const { html } = await postForm(app, "/sessions", {
      prompt: "start fresh",
      working_dir: newDir,
    });
    expect(insertedIds).toHaveLength(1);
    expect(insertedIds[0]).not.toBe("old-collision");
    expect(html).toContain(`data-session-id="${insertedIds[0]}"`);
    // old-collision now also appears in the sidebar list (every item carries
    // data-session-id), so scope the negative check to the detail pane,
    // identified by data-run-status which is detail-only.
    expect(html).toContain(
      `data-session-id="${insertedIds[0]}" data-run-status`,
    );
    expect(html).not.toMatch(
      /data-session-id="old-collision"[^>]*data-run-status/,
    );
  });

  it("rejects an empty prompt without spawning goose", async () => {
    const { spawn, invocations } = createNewSessionSpawn(newDb, []);
    const app = makeNewApp(spawn);
    const { status, html } = await postForm(app, "/sessions", {
      prompt: "   ",
      working_dir: newDir,
    });
    expect(status).toBe(422);
    expect(invocations).toHaveLength(0);
    expect(html).toContain("prompt is required");
    // The rejected form keeps the directory the user entered rather than
    // resetting it to the server's cwd.
    expect(html).toContain(`value="${newDir}"`);
  });

  it("rejects a non-existent working directory", async () => {
    const { spawn, invocations } = createNewSessionSpawn(newDb, []);
    const app = makeNewApp(spawn);
    const { status, html } = await postForm(app, "/sessions", {
      prompt: "hello",
      working_dir: "/no/such/dir/anywhere",
    });
    expect(status).toBe(422);
    expect(invocations).toHaveLength(0);
    expect(html).toContain("does not exist");
  });

  it("reports an error when goose never creates a session", async () => {
    // A plain mock that never inserts a DB row → the poll times out.
    const { spawn, invocations } = createMockSpawn(["x"], { delayMs: 200 });
    const app = makeNewApp(spawn, 300);
    const { status, html } = await postForm(app, "/sessions", {
      prompt: "hello",
      working_dir: newDir,
    });
    expect(status).toBe(502);
    expect(html).toContain("did not create a session");
    // the orphaned run was stopped
    expect(invocations).toHaveLength(1);
  });
});

// === Session-running indicator ===

describe("session-running indicator (sidebar render)", () => {
  it("marks a running session with data-running in the sidebar", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const res = await app.request("/");
    const html = await res.text();
    // The alpha card carries the data-running hook + indicator markup.
    expect(html).toContain('data-session-id="alpha"');
    const alphaCard = html.match(/data-session-id="alpha"[^>]*data-running/);
    expect(alphaCard).not.toBeNull();
    expect(html).toContain("run-indicator");
    expect(html).toContain("run-dot");
  });

  it("omits data-running for idle sessions", async () => {
    const app = makeApp();
    const res = await app.request("/");
    const html = await res.text();
    expect(html).not.toContain("data-running");
    // The indicator markup is always present (hidden via CSS).
    expect(html).toContain("run-indicator");
  });

  it("only marks the running session, not its siblings", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const res = await app.request("/");
    const html = await res.text();
    // Beta is idle — its card must not carry data-running.
    const betaCard = html.match(/data-session-id="beta"[^>]*data-running/);
    expect(betaCard).toBeNull();
  });

  it("reflects the running state in the out-of-band sidebar swap", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const { html } = await postForm(app, "/sessions/alpha/rename", {
      name: "Renamed",
      from: "sidebar",
    });
    const alphaCard = html.match(/data-session-id="alpha"[^>]*data-running/);
    expect(alphaCard).not.toBeNull();
  });

  it("removes data-running once a run reaches a terminal status", async () => {
    const { spawn } = createMockSpawn(["x"]);
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
    await sleep(150);

    const res = await app.request("/");
    const html = await res.text();
    expect(html).not.toContain("data-running");
  });
});

describe("GET /events/status (SSE)", () => {
  it("responds with an event-stream content type", async () => {
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG), {
      statusPollMs: 15,
      maxStatusPolls: 1,
    });
    const res = await app.request("/events/status");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.text();
  });

  it("emits a sync event listing currently active sessions", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
      statusPollMs: 15,
      maxStatusPolls: 2,
    });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const res = await app.request("/events/status");
    const text = await res.text();
    expect(text).toContain("event: sync");
    expect(text).toContain("alpha");
  });

  it("emits an empty sync when no runs are active", async () => {
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG), {
      statusPollMs: 15,
      maxStatusPolls: 1,
    });
    const res = await app.request("/events/status");
    const text = await res.text();
    expect(text).toContain("event: sync");
    expect(text).toContain("data: []");
  });

  it("emits status and done deltas as a run starts and ends", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 150 });
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
      statusPollMs: 20,
      maxStatusPolls: 25,
    });

    // Connect before any run exists — the initial sync is empty.
    const statusPromise = (async () => {
      const res = await app.request("/events/status");
      return res.text();
    })();
    await sleep(30);

    // Start a run that stays alive ~150ms, then completes.
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
    await sleep(250);

    const text = await statusPromise;
    // The feed saw alpha appear (queued/running) and then disappear (done).
    expect(text).toContain("event: status");
    expect(text).toContain('"sessionId":"alpha"');
    expect(text).toContain('"status":"done"');
  });

  it("lists multiple concurrent runs in the sync snapshot", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
      statusPollMs: 15,
      maxStatusPolls: 2,
    });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/beta/prompt", { prompt: "second" });

    const res = await app.request("/events/status");
    const text = await res.text();
    expect(text).toContain("event: sync");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });

  it("emits a rename event when a session name changes mid-run", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
      statusPollMs: 20,
      maxStatusPolls: 40,
    });
    try {
      // Connect before the run starts so the feed tracks alpha from the off.
      const statusPromise = (async () => {
        const res = await app.request("/events/status");
        return res.text();
      })();
      await sleep(30);

      // Start a run that stays alive long enough to be renamed mid-flight.
      await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });
      await sleep(60);

      // goose renames the session mid-run once it has conversational context.
      db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(
        "Build the project",
        "alpha",
      );

      const text = await statusPromise;
      expect(text).toContain("event: rename");
      expect(text).toContain('"sessionId":"alpha"');
      expect(text).toContain('"name":"Build the project"');
    } finally {
      // Restore the shared DB so sibling tests still see "Alpha Session".
      db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(
        "Alpha Session",
        "alpha",
      );
    }
  });

  it("emits the current name for active sessions on connect", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
      statusPollMs: 15,
      maxStatusPolls: 1,
    });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "hello" });

    const res = await app.request("/events/status");
    const text = await res.text();
    // A reconnect must reconcile names that drifted during the disconnect,
    // not just the running indicators.
    expect(text).toContain("event: rename");
    expect(text).toContain('"sessionId":"alpha"');
    expect(text).toContain('"name":"Alpha Session"');
  });

  it("emits a rename for a session the viewer did not start (CLI session)", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
      statusPollMs: 20,
      maxStatusPolls: 40,
    });
    try {
      // No prompt is posted, so "alpha" is never added to the runner registry
      // — it models a session started externally from the goose CLI. The feed
      // must still push the rename once goose derives a title.
      const statusPromise = (async () => {
        const res = await app.request("/events/status");
        return res.text();
      })();
      await sleep(30);

      db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(
        "Refactor the parser",
        "alpha",
      );

      const text = await statusPromise;
      expect(text).toContain("event: rename");
      expect(text).toContain('"sessionId":"alpha"');
      expect(text).toContain('"name":"Refactor the parser"');
    } finally {
      db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(
        "Alpha Session",
        "alpha",
      );
    }
  });
});

describe("session-running indicator (client wiring)", () => {
  it("wires the sidebar client to the global status feed", async () => {
    const res = await makeApp().request("/assets/sidebar.js");
    const body = await res.text();
    expect(body).toContain("/events/status");
    expect(body).toContain("EventSource");
    expect(body).toContain("data-running");
  });
});

const renderSessionDom = async (id: string): Promise<JSDOM> =>
  new JSDOM((await renderSession(id)).html);

const PR_URL = "https://github.com/SynthLuvr/lisko/pull/56";

describe("PR chip rendering", () => {
  const seedPrSession = (): string => {
    const prDir = mkdtempSync(join(tmpdir(), "glv-prchip-"));
    const prDb = new DatabaseSync(join(prDir, "sessions.db"));
    prDb.exec(SCHEMA);
    prDb
      .prepare(
        "INSERT INTO sessions (id, name, session_type, working_dir, " +
          "updated_at, total_tokens, provider_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "prsess",
        "PR Session",
        "user",
        "/tmp/pr",
        "2026-07-13 10:00:00",
        5,
        null,
      );
    prDb
      .prepare(
        "INSERT INTO messages (session_id, role, content_json, " +
          "created_timestamp) VALUES (?, ?, ?, ?)",
      )
      .run(
        "prsess",
        "user",
        JSON.stringify([
          {
            type: "toolResponse",
            id: "call_1",
            toolResult: {
              status: "success",
              value: {
                content: [{ type: "text", text: PR_URL }],
                isError: false,
              },
            },
          },
        ]),
        1,
      );
    return prDir;
  };

  // Bare-URL tool result (the `gh pr create` signature) so detection resolves to one chip.
  const renderPrSession = async (): Promise<string> => {
    const prDir = seedPrSession();
    try {
      const prDb = new DatabaseSync(join(prDir, "sessions.db"));
      try {
        return await (
          await createApp(prDb, createRunner(DEFAULT_RUNNER_CONFIG)).request(
            "/sessions/prsess",
          )
        ).text();
      } finally {
        prDb.close();
      }
    } finally {
      rmSync(prDir, { recursive: true, force: true });
    }
  };

  it("renders no chip when a session has no PR", async () => {
    const html = (await renderSession("alpha")).html;
    expect(html).not.toContain("pr-chip");
  });

  it("renders a chip linking the detected PR (loading state, new tab)", async () => {
    const html = await renderPrSession();
    expect(html).toContain("pr-chip");
    expect(html).toContain(PR_URL);
    expect(html).toContain("#56");
    expect(html).toContain('target="_blank"');
    expect(html).toContain("/sessions/prsess/pr-state");
    expect(html).toContain("pr-state-loading");
    expect(html).toContain("pr-dot-loading");
  });
});

describe("PR status endpoint GET /sessions/:id/pr-state", () => {
  const appWithRunner = (stdout: string) =>
    createApp(db, createRunner(DEFAULT_RUNNER_CONFIG), {
      runPrState: async () => ({ stdout }),
    });

  const fetchState = (stdout: string, url: string = PR_URL) =>
    appWithRunner(stdout).request(
      `/sessions/alpha/pr-state?url=${encodeURIComponent(url)}`,
    );

  it("returns a green open-tinted badge for OPEN", async () => {
    const body = await (await fetchState('{"state":"OPEN"}')).text();
    expect(body).toContain("pr-state-open");
    expect(body).toContain("Open");
  });

  it("returns a purple merged-tinted badge for MERGED", async () => {
    const body = await (await fetchState('{"state":"MERGED"}')).text();
    expect(body).toContain("pr-state-merged");
    expect(body).toContain("Merged");
  });

  it("returns a gray closed-tinted badge for CLOSED", async () => {
    const body = await (await fetchState('{"state":"CLOSED"}')).text();
    expect(body).toContain("pr-state-closed");
    expect(body).toContain("Closed");
  });

  it("returns an empty body when gh is unauthed (help text, exit 0)", async () => {
    const body = await (await fetchState("Usage: gh pr view ...")).text();
    expect(body).toBe("");
  });

  it("returns an empty body for non-JSON output (missing gh, timeout)", async () => {
    const body = await (
      await fetchState("Could not resolve to a PullRequest")
    ).text();
    expect(body).toBe("");
  });

  it("returns an empty body for a non-PR url", async () => {
    const body = await (
      await fetchState('{"state":"OPEN"}', "https://evil.example/x")
    ).text();
    expect(body).toBe("");
  });

  it("never propagates a runner failure to the page", async () => {
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG), {
      runPrState: async () => {
        throw new Error("network down");
      },
    });
    const body = await (
      await app.request(
        `/sessions/alpha/pr-state?url=${encodeURIComponent(PR_URL)}`,
      )
    ).text();
    expect(body).toBe("");
  });
});

describe("git info endpoint GET /sessions/:id/git-info", () => {
  // The session header's git chips are derived from the PR the session
  // created: the branch comes from the PR link (via `gh`), and the worktree
  // is the local checkout on that branch. Each test seeds a transcript that
  // mentions a PR URL, then injects the `gh` (runPrState) and `git` (runGit)
  // answers.
  const PR = "https://github.com/SynthLuvr/lisko/pull/35";

  const seedPrSession = (
    database: DatabaseSync,
    id: string,
    workingDir: string,
  ): void => {
    database
      .prepare("INSERT INTO sessions (id, working_dir) VALUES (?, ?)")
      .run(id, workingDir);
    database
      .prepare(
        "INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)",
      )
      .run(
        id,
        "user",
        JSON.stringify([
          {
            type: "toolResponse",
            toolResult: { value: { content: [{ type: "text", text: PR }] } },
          },
        ]),
        1,
      );
  };

  const setup = (): DatabaseSync => {
    const dir = mkdtempSync(join(tmpdir(), "glv-gi-"));
    const database = new DatabaseSync(join(dir, "sessions.db"));
    database.exec(SCHEMA);
    return database;
  };

  const gitApp = (
    database: DatabaseSync,
    opts: { branch?: string; porcelain?: string; runGit?: GitRunner },
  ) => {
    const runPrState = async () => ({
      stdout:
        opts.branch === undefined
          ? ""
          : JSON.stringify({ headRefName: opts.branch }),
    });
    return createApp(database, createRunner(DEFAULT_RUNNER_CONFIG), {
      runPrState,
      runGit:
        opts.runGit ??
        (async () => ({ stdout: opts.porcelain ?? "", exitCode: 0 })),
    });
  };

  it("renders the branch from the PR link and the matching worktree", async () => {
    const database = setup();
    seedPrSession(database, "gi", "/main");
    const porcelain =
      "worktree /main\nbranch refs/heads/main\n\nworktree /feat\nbranch refs/heads/feat/x";
    const body = await (
      await gitApp(database, { branch: "feat/x", porcelain }).request(
        "/sessions/gi/git-info",
      )
    ).text();
    expect(body).toContain("git-chip-branch");
    expect(body).toContain("feat/x");
    expect(body).toContain("git-chip-worktree");
    expect(body).toContain("/feat");
    expect(body).not.toContain("/main");
  });

  it("renders the worktree chip as a link that pre-fills New Session", async () => {
    const database = setup();
    seedPrSession(database, "gi", "/feat");
    const porcelain = "worktree /feat\nbranch refs/heads/feat/x";
    const body = await (
      await gitApp(database, { branch: "feat/x", porcelain }).request(
        "/sessions/gi/git-info",
      )
    ).text();
    // The worktree chip is an anchor that swaps the detail pane, opening the
    // new-session form with that working directory pre-filled (URL-encoded).
    expect(body).toContain('<a class="git-chip git-chip-worktree"');
    expect(body).toContain('href="/sessions/new?working_dir=%2Ffeat"');
    expect(body).toContain('hx-target="#detail-pane"');
    // The branch chip stays a non-navigable span.
    expect(body).toContain('<span class="git-chip git-chip-branch"');
  });

  it("renders only the branch chip when no worktree is on that branch", async () => {
    const database = setup();
    seedPrSession(database, "gi", "/main");
    const body = await (
      await gitApp(database, {
        branch: "feat/x",
        porcelain: "worktree /main\nbranch refs/heads/main",
      }).request("/sessions/gi/git-info")
    ).text();
    expect(body).toContain("feat/x");
    expect(body).not.toContain("git-chip-worktree");
  });

  it("returns an empty body when the session has no PR link", async () => {
    const database = setup();
    database
      .prepare("INSERT INTO sessions (id, working_dir) VALUES (?, ?)")
      .run("nopr", "/repo");
    const body = await (
      await gitApp(database, {
        branch: "feat/x",
        porcelain: "worktree /repo\nbranch refs/heads/feat/x",
      }).request("/sessions/nopr/git-info")
    ).text();
    expect(body).toBe("");
  });

  it("returns an empty body when gh cannot resolve the branch", async () => {
    const database = setup();
    seedPrSession(database, "gi", "/feat");
    const body = await (
      await gitApp(database, {
        porcelain: "worktree /feat\nbranch refs/heads/feat/x",
      }).request("/sessions/gi/git-info")
    ).text();
    expect(body).toBe("");
  });

  it("returns an empty body for a missing session", async () => {
    const database = setup();
    const body = await (
      await gitApp(database, {
        branch: "feat/x",
        porcelain: "worktree /feat\nbranch refs/heads/feat/x",
      }).request("/sessions/missing/git-info")
    ).text();
    expect(body).toBe("");
  });

  it("still renders the branch when the git runner throws", async () => {
    const database = setup();
    seedPrSession(database, "gi", "/feat");
    const body = await (
      await gitApp(database, {
        branch: "feat/x",
        runGit: async () => {
          throw new Error("git missing");
        },
      }).request("/sessions/gi/git-info")
    ).text();
    // gh resolved the branch, so the chip renders; git failed, so no worktree.
    expect(body).toContain("feat/x");
    expect(body).not.toContain("git-chip-worktree");
  });
});

describe("sidebar meta endpoint GET /sessions/sidebar-meta", () => {
  // The runner is keyed on cwd so one fake answers any session.
  const runnerFor =
    (out: (cwd: string) => string): GitRunner =>
    async (_args, cwd) => ({ stdout: out(cwd), exitCode: 0 });

  const fetchMeta = async (runGit?: GitRunner): Promise<string> => {
    const app = createApp(db, createRunner(DEFAULT_RUNNER_CONFIG), { runGit });
    return (await app.request("/sessions/sidebar-meta")).text();
  };

  it("returns an out-of-band swap span for every visible (user) session", async () => {
    const body = await fetchMeta();
    expect(body).toContain('id="sidebar-meta-alpha"');
    expect(body).toContain('id="sidebar-meta-beta"');
    expect(body).toContain('id="sidebar-meta-gamma"');
    // The hidden "silent" session is filtered out by the viewer filter.
    expect(body).not.toContain('id="sidebar-meta-silent"');
    expect(body).toContain('hx-swap-oob="true"');
  });

  it("renders a compact branch chip for git-repo sessions", async () => {
    const body = await fetchMeta(
      runnerFor((cwd) => `worktree ${cwd}\nbranch refs/heads/feat/sidebar\n`),
    );
    expect(body).toContain("git-chip-sm");
    expect(body).toContain("feat/sidebar");
  });

  it("omits chips for a session with no branch and no PR", async () => {
    const body = await fetchMeta(); // no runGit -> no branch anywhere
    const alpha = body.match(/id="sidebar-meta-alpha"[\s\S]*?<\/span>/);
    expect(alpha).not.toBeNull();
    expect(alpha?.[0]).not.toContain("git-chip");
    expect(alpha?.[0]).not.toContain("pr-chip");
  });

  it("dedupes git lookups by working dir (not one call per session)", async () => {
    const sbDir = mkdtempSync(join(tmpdir(), "glv-sbmeta-"));
    try {
      const sbDb = new DatabaseSync(join(sbDir, "sessions.db"));
      sbDb.exec(SCHEMA);
      const ins = sbDb.prepare(
        "INSERT INTO sessions (id, name, session_type, working_dir, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      // Two sessions share /tmp/shared; a third lives elsewhere.
      ins.run("s1", "S1", "user", "/tmp/shared", "2026-07-13 10:00:00");
      ins.run("s2", "S2", "user", "/tmp/shared", "2026-07-13 09:00:00");
      ins.run("s3", "S3", "user", "/tmp/other", "2026-07-13 08:00:00");
      let calls = 0;
      const counting: GitRunner = async () => {
        calls += 1;
        return { stdout: "worktree /x\ndetached\n", exitCode: 0 };
      };
      const app = createApp(sbDb, createRunner(DEFAULT_RUNNER_CONFIG), {
        runGit: counting,
      });
      await app.request("/sessions/sidebar-meta");
      // /tmp/shared once, /tmp/other once — never once per session.
      expect(calls).toBe(2);
      sbDb.close();
    } finally {
      rmSync(sbDir, { recursive: true, force: true });
    }
  });

  it("includes a compact PR chip that lazy-loads state for a session with a PR", async () => {
    const url = "https://github.com/SynthLuvr/lisko/pull/56";
    const prDir = mkdtempSync(join(tmpdir(), "glv-sbmeta-pr-"));
    try {
      const prDb = new DatabaseSync(join(prDir, "sessions.db"));
      prDb.exec(SCHEMA);
      prDb
        .prepare(
          "INSERT INTO sessions (id, name, session_type, working_dir, " +
            "updated_at, total_tokens, provider_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "prsess",
          "PR Session",
          "user",
          "/tmp/pr",
          "2026-07-13 10:00:00",
          5,
          null,
        );
      // Bare-URL tool result (the `gh pr create` signature) resolves to a chip.
      prDb
        .prepare(
          "INSERT INTO messages (session_id, role, content_json, " +
            "created_timestamp) VALUES (?, ?, ?, ?)",
        )
        .run(
          "prsess",
          "user",
          JSON.stringify([
            {
              type: "toolResponse",
              id: "call_1",
              toolResult: {
                status: "success",
                value: {
                  content: [{ type: "text", text: url }],
                  isError: false,
                },
              },
            },
          ]),
          1,
        );
      const app = createApp(prDb, createRunner(DEFAULT_RUNNER_CONFIG));
      const body = await (await app.request("/sessions/sidebar-meta")).text();
      expect(body).toContain("pr-chip-sm");
      expect(body).toContain(url);
      expect(body).toContain("#56");
      expect(body).toContain("/sessions/prsess/pr-state");
      expect(body).toContain("#sb-pr-state-prsess");
      expect(body).toContain("pr-state-loading");
      prDb.close();
    } finally {
      rmSync(prDir, { recursive: true, force: true });
    }
  });

  it("never propagates a git runner failure to the response", async () => {
    const failing: GitRunner = async () => {
      throw new Error("spawn failed");
    };
    const body = await fetchMeta(failing);
    // Still returns spans, just without branch chips.
    expect(body).toContain('id="sidebar-meta-alpha"');
    expect(body).not.toContain("git-chip-sm");
  });
});

describe("stream client session selector", () => {
  // Sidebar cards carry data-session-id too and precede #detail-pane. Viewing
  // gamma (not the first-listed alpha) exposes the bare-selector collision.
  it("resolves the transcript root inside #detail-pane, not a sidebar card", async () => {
    const document = (await renderSessionDom("gamma")).window.document;

    const bare = document.querySelector("[data-session-id]");
    expect(bare?.classList.contains("session-item")).toBe(true);
    expect(bare?.hasAttribute("data-run-status")).toBe(false);

    const scoped = document.querySelector("#detail-pane [data-session-id]");
    expect(scoped?.getAttribute("data-session-id")).toBe("gamma");
  });

  it("connects the live stream to the viewed session, not the first sidebar card", async () => {
    const dom = await renderSessionDom("gamma");
    const document = dom.window.document;
    const connected: string[] = [];
    class FakeEventSource {
      constructor(url: string) {
        connected.push(url);
      }
      addEventListener(): void {
        // only the requested URL is asserted
      }
    }
    const streamJs = await (
      await makeApp().request("/assets/stream.js")
    ).text();
    vm.runInNewContext(streamJs, {
      document,
      EventSource: FakeEventSource,
    });
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    expect(connected).toEqual(["/sessions/gamma/tail"]);
  });
});

describe("UI polish: branding, assets, and a11y", () => {
  it("includes a favicon and document metadata in the head", async () => {
    const html = await renderRoot();
    expect(html).toContain('rel="icon"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="color-scheme"');
    expect(html).toContain('name="theme-color"');
  });

  it("renders the new-session button as an svg icon", async () => {
    const html = await renderRoot();
    const start = html.indexOf('class="new-session-btn"');
    const end = html.indexOf("</a>", start);
    const btn = html.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(btn).toContain("<svg");
    expect(btn).toContain('aria-label="Start a new session"');
  });

  it("loads the ui enhancement script", async () => {
    const html = await renderRoot();
    expect(html).toContain('<script src="/assets/ui.js"');
  });

  it("serves the ui client script as JavaScript", async () => {
    const res = await makeApp().request("/assets/ui.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("copy-code-btn");
    expect(body).toContain("scroll-latest");
    expect(body).toContain("session-title");
  });

  it("marks the run status hint as an ARIA live region", async () => {
    const { spawn } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    const { html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "hello",
    });
    expect(html).toContain("status-hint running");
    expect(html).toContain('aria-live="polite"');
  });
});
