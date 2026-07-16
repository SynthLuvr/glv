import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { createApp } from "../server.js";

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

  it("shows a placeholder in the detail pane", async () => {
    const html = await renderRoot();
    expect(html).toContain("No session selected");
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
    expect(html).toContain('<script src="/htmx.min.js"');
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
    const res = await makeApp().request("/htmx.min.js");
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
    expect(html).toContain('rel="stylesheet" href="/app.css"');
    expect(html).toContain('<script src="/sidebar.js"');
  });

  it("serves the stylesheet as CSS", async () => {
    const res = await makeApp().request("/app.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const body = await res.text();
    expect(body).toContain("--color-accent");
    expect(body).toContain(".session-item");
  });

  it("serves the sidebar client script as JavaScript", async () => {
    const res = await makeApp().request("/sidebar.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain(".session-check");
    expect(body.length).toBeGreaterThan(100);
  });

  it("serves the markdown-copy client script as JavaScript", async () => {
    const res = await makeApp().request("/markdown-copy.js");
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

  it("returns only the placeholder fragment for the root", async () => {
    const { html } = await renderHtmx("/");
    expect(html).not.toContain("<html");
    expect(html).toContain("No session selected");
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
    expect(html).toContain("No session selected");
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
): Promise<{ status: number; html: string }> => {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
    expect(html).toContain('<script src="/stream.js"');
  });

  it("serves the stream client script as JavaScript", async () => {
    const res = await makeApp().request("/stream.js");
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
    const res = await makeApp().request("/stream.js");
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
    const res = await makeApp().request("/stream.js");
    const body = await res.text();
    // The tail URL suffix and the SSE event name survive minification as
    // string literals, confirming the client wires the live-tail stream.
    expect(body).toContain("/tail");
    expect(body).toContain('"append"');
    expect(body).toContain("nearBottom");
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
});
