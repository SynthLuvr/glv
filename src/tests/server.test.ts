import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProcessResult, SpawnFn } from "../runner.js";
import {
  createRunner,
  DEFAULT_RUNNER_CONFIG,
  getHandle,
  makeRunnerConfig,
} from "../runner.js";
import { createApp, expandHome, listHomeDirs } from "../server.js";

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
    expect(html).toContain("anthropic");
    expect(html).toContain("1,234");
    expect(html).toContain("session-item");
    expect(html).toContain("provider-badge");
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
    expect(html).toContain("anthropic");
    expect(html).toContain("1,234");
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

  const row = (id: string): { name: string; user_set_name: number } =>
    renameDb
      .prepare("SELECT name, user_set_name FROM sessions WHERE id = ?")
      .get(id) as { name: string; user_set_name: number };

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
  it("submits a prompt and shows the running state with Stop button", async () => {
    const { spawn } = createMockSpawn(["line1"], { delayMs: 500 });
    const app = makeApp(spawn);
    const { status, html } = await postForm(app, "/sessions/alpha/prompt", {
      prompt: "hello goose",
    });
    expect(status).toBe(200);
    expect(html).toContain("hello goose");
    expect(html).toContain("disabled");
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

  it("keeps the existing run when a second prompt is submitted", async () => {
    const { spawn, invocations } = createMockSpawn(["x"], { delayMs: 500 });
    const app = makeApp(spawn);
    await postForm(app, "/sessions/alpha/prompt", { prompt: "first" });
    await postForm(app, "/sessions/alpha/prompt", { prompt: "second" });
    expect(invocations).toHaveLength(1);
    expect(invocations[0].opts.stdin).toBe("first");
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
    expect(html).toContain('id="meta-messages"');
    expect(html).toContain('id="meta-tokens"');
  });

  it("renders a hidden live-watching badge in the header", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain('id="live-badge"');
    expect(html).toContain("Watching");
    expect(html).toContain("hidden");
  });

  it("tags each rendered message with a stable data-msg-index", async () => {
    const { html } = await renderSession("alpha");
    expect(html).toContain("data-msg-index");
  });
});

describe("M6: stream client live-tail polish wiring", () => {
  it("handles replace, meta, and live-badge events", async () => {
    const res = await makeApp().request("/assets/stream.js");
    const body = await res.text();
    expect(body).toContain('"replace"');
    expect(body).toContain('"meta"');
    expect(body).toContain("live-badge");
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
    // alpha shipped with 4 visible messages; the append brings it to 5
    expect(text).toContain('"messages":"5"');
    expect(text).toContain('"tokens":"5,678"');
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
