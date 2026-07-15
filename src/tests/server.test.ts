import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const renderRoot = async (): Promise<string> => {
  const res = await createApp(db).request("/");
  return res.text();
};

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
      const res = await createApp(emptyDb).request("/");
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
});

const renderSession = async (
  id: string,
): Promise<{ status: number; html: string }> => {
  const res = await createApp(db).request(`/sessions/${id}`);
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
});

describe("transcript readability (markdown, thinking, tools)", () => {
  it("renders assistant text as markdown", async () => {
    const { html } = await renderSession("gamma");
    expect(html).toContain("<h2>Done</h2>");
    expect(html).toContain("<strong>succeeded</strong>");
    expect(html).toContain("no errors");
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
  const res = await createApp(db).request(path, {
    headers: { "HX-Request": "true" },
  });
  return { status: res.status, html: await res.text() };
};

describe("web viewer htmx asset", () => {
  it("serves the vendored htmx library as JavaScript", async () => {
    const res = await createApp(db).request("/htmx.min.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain("htmx");
    expect(body.length).toBeGreaterThan(1000);
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

  it("sends an out-of-band sidebar update that moves the selection", async () => {
    const { html } = await renderHtmx("/sessions/alpha");
    expect(html).toContain('id="session-list"');
    expect(html).toContain('hx-swap-oob="true"');
    expect(html).toContain('class="session-item selected"');
    expect(html).toContain("Alpha Session");
    expect(html).toContain("Beta Session");
  });

  it("returns only the placeholder fragment for the root", async () => {
    const { html } = await renderHtmx("/");
    expect(html).not.toContain("<html");
    expect(html).toContain("No session selected");
    expect(html).toContain('hx-swap-oob="true"');
  });

  it("returns a 404 fragment for an unknown session", async () => {
    const { status, html } = await renderHtmx("/sessions/missing");
    expect(status).toBe(404);
    expect(html).toContain("Session not found");
    expect(html).not.toContain("<html");
  });
});
