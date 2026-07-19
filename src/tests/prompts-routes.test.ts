import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bumpUsage,
  createPrompt,
  getPrompt,
  listPrompts,
  openPromptsDb,
} from "../prompts/db.js";
import type { ProcessResult, SpawnFn } from "../runner/index.js";
import { createRunner, DEFAULT_RUNNER_CONFIG } from "../runner/index.js";
import { createApp } from "../server/index.js";

const SESSIONS_SCHEMA = `
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

type Invocation = { binary: string; args: string[]; opts: { cwd: string } };

// Minimal spawn that inserts a session row synchronously so the new-session
// poll resolves; mirrors createNewSessionSpawn in server.test.ts.
const makeSpawn = (db: DatabaseSync): SpawnFn => {
  const invocations: Invocation[] = [];
  let counter = 0;
  const spawn: SpawnFn = (binary, args, opts) => {
    invocations.push({ binary, args, opts });
    const id = `pr-${Date.now()}-${++counter}`;
    db.prepare(
      "INSERT INTO sessions (id, name, session_type, working_dir) " +
        "VALUES (?, 'p', 'user', ?)",
    ).run(id, opts.cwd);
    let resolveExit!: (r: ProcessResult) => void;
    const exit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });
    const stdout = (async function* () {
      yield '{"type":"session_start"}';
      resolveExit({ exitCode: 0 });
    })();
    return { pid: 1, kill: () => undefined, stdout, exit };
  };
  return spawn;
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

let sessionsDb: DatabaseSync;
let promptsDb: DatabaseSync;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-prompts-routes-"));
  sessionsDb = new DatabaseSync(join(dir, "sessions.db"));
  sessionsDb.exec(SESSIONS_SCHEMA);
  promptsDb = openPromptsDb(join(dir, "prompts.db"));
});

afterAll(() => {
  sessionsDb.close();
  promptsDb.close();
  rmSync(dir, { recursive: true, force: true });
});

const makeApp = (spawn?: SpawnFn) =>
  createApp(sessionsDb, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
    prompts: promptsDb,
  });

describe("new-session page wiring", () => {
  it("includes the saved prompts library and prompt-id field", async () => {
    createPrompt(promptsDb, { title: "Page prompt", body: "b" });
    const html = await (await makeApp().request("/")).text();
    expect(html).toContain("Saved prompts");
    expect(html).toContain('name="prompt_id"');
    expect(html).toContain("Page prompt");
    expect(html).toContain("/assets/prompts.js");
  });
});

describe("GET /prompts", () => {
  it("renders the library panel with a filter and cards", async () => {
    createPrompt(promptsDb, { title: "Library card", body: "do the thing" });
    const html = await (await makeApp().request("/prompts")).text();
    expect(html).toContain("prompt-filter");
    expect(html).toContain("Library card");
  });
});

describe("POST /prompts", () => {
  it("creates a prompt and returns the out-of-band library", async () => {
    const { status, html } = await postForm(makeApp(), "/prompts", {
      title: "Review PR",
      body: "Review this PR for bugs.",
      category: "review",
    });
    expect(status).toBe(200);
    expect(html).toContain("Review PR");
    expect(html).toContain('hx-swap-oob="true"');
    expect(listPrompts(promptsDb).map((p) => p.title)).toContain("Review PR");
  });

  it("re-renders the form with an error on an empty title/body", async () => {
    const { status, html } = await postForm(makeApp(), "/prompts", {
      title: "  ",
      body: "",
    });
    expect(status).toBe(200);
    expect(html).toContain("required");
    expect(html).toContain('data-prompt-form="save"');
  });

  it("loads the save form via GET /prompts/new", async () => {
    const html = await (await makeApp().request("/prompts/new")).text();
    expect(html).toContain('data-prompt-form="save"');
    expect(html).toContain('name="title"');
  });
});

describe("prompt edit, update, and delete", () => {
  it("returns the edit form for an existing prompt", async () => {
    const prompt = createPrompt(promptsDb, {
      title: "Edit me",
      body: "body",
      category: "x",
    });
    const html = await (
      await makeApp().request(`/prompts/${prompt.id}/edit`)
    ).text();
    expect(html).toContain("Edit me");
    expect(html).toContain(`hx-put="/prompts/${prompt.id}"`);
  });

  it("updates the prompt and returns the card", async () => {
    const prompt = createPrompt(promptsDb, { title: "Before", body: "b" });
    const res = await makeApp().request(`/prompts/${prompt.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: "After",
        body: "updated",
        category: "review",
      }).toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("After");
    expect(getPrompt(promptsDb, prompt.id)?.title).toBe("After");
    expect(getPrompt(promptsDb, prompt.id)?.category).toBe("review");
  });

  it("rejects an empty title with the edit form, leaving the row unchanged", async () => {
    const prompt = createPrompt(promptsDb, { title: "Keep", body: "b" });
    const res = await makeApp().request(`/prompts/${prompt.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "", body: "" }).toString(),
    });
    expect(await res.text()).toContain("required");
    expect(getPrompt(promptsDb, prompt.id)?.title).toBe("Keep");
  });

  it("cancelling edit reverts to the card view", async () => {
    const prompt = createPrompt(promptsDb, { title: "Revert", body: "b" });
    const html = await (
      await makeApp().request(`/prompts/${prompt.id}/card`)
    ).text();
    expect(html).toContain("Revert");
    expect(html).toContain("prompt-card");
  });

  it("deletes the prompt", async () => {
    const prompt = createPrompt(promptsDb, { title: "Gone", body: "b" });
    const res = await makeApp().request(`/prompts/${prompt.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(getPrompt(promptsDb, prompt.id)).toBeUndefined();
  });
});

describe("run flow with a saved prompt", () => {
  it("bumps usage when a session starts from a saved prompt", async () => {
    const prompt = createPrompt(promptsDb, {
      title: "Run me",
      body: "build it",
    });
    const { status } = await postForm(
      makeApp(makeSpawn(sessionsDb)),
      "/sessions",
      { prompt: "build it", working_dir: dir, prompt_id: prompt.id },
      { "HX-Request": "true" },
    );
    expect(status).toBe(200);
    expect(getPrompt(promptsDb, prompt.id)?.usageCount).toBe(1);
    expect(getPrompt(promptsDb, prompt.id)?.lastUsedAt).not.toBeNull();
  });

  it("does not bump usage when prompt_id is absent", async () => {
    const prompt = createPrompt(promptsDb, { title: "Unbumped", body: "b" });
    await postForm(
      makeApp(makeSpawn(sessionsDb)),
      "/sessions",
      { prompt: "hello", working_dir: dir },
      { "HX-Request": "true" },
    );
    expect(getPrompt(promptsDb, prompt.id)?.usageCount).toBe(0);
  });
});

describe("prompt library view modes", () => {
  it("renders both view toggles in the toolbar", async () => {
    const html = await (await makeApp().request("/prompts")).text();
    expect(html).toContain("Frequently used");
    expect(html).toContain("Group by category");
  });

  it("groups prompts into collapsible category sections", async () => {
    createPrompt(promptsDb, {
      title: "GroupedA",
      body: "b",
      category: "alpha",
    });
    createPrompt(promptsDb, { title: "GroupedB", body: "b", category: "beta" });
    createPrompt(promptsDb, { title: "GroupedUncat", body: "b" });
    const html = await (await makeApp().request("/prompts?grouped=1")).text();
    expect(html).toContain("prompt-group");
    expect(html).toContain("prompt-group-name");
    // Categorised sections appear, uncategorised lands in "Ungrouped".
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).toContain("Ungrouped");
  });

  it("orders by usage when sort=usage", async () => {
    const hot = createPrompt(promptsDb, { title: "UsageHot", body: "b" });
    createPrompt(promptsDb, { title: "UsageCold", body: "b" });
    bumpUsage(promptsDb, hot.id);
    bumpUsage(promptsDb, hot.id);
    const html = await (await makeApp().request("/prompts?sort=usage")).text();
    // The frequently-used prompt must render before the never-used one.
    expect(html.indexOf("UsageHot")).toBeLessThan(html.indexOf("UsageCold"));
  });

  it("marks the active toggle state in the rendered toolbar", async () => {
    const grouped = await (
      await makeApp().request("/prompts?grouped=1")
    ).text();
    expect(grouped).toContain("prompt-toggle active");
    const usage = await (await makeApp().request("/prompts?sort=usage")).text();
    expect(usage).toContain("prompt-toggle active");
  });
});

describe("manual reordering endpoint", () => {
  it("persists the posted order via POST /prompts/reorder", async () => {
    const first = createPrompt(promptsDb, { title: "ReorderFirst", body: "b" });
    const second = createPrompt(promptsDb, {
      title: "ReorderSecond",
      body: "b",
    });
    const res = await makeApp().request("/prompts/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `order=${encodeURIComponent([second.id, first.id].join(","))}`,
    });
    expect(res.status).toBe(200);
    // second now sorts ahead of first.
    expect(getPrompt(promptsDb, second.id)?.sortOrder).toBeLessThan(
      getPrompt(promptsDb, first.id)?.sortOrder ?? Number.POSITIVE_INFINITY,
    );
  });

  it("is a 404 when the prompts store is disabled", async () => {
    const app = createApp(sessionsDb, createRunner(DEFAULT_RUNNER_CONFIG), {});
    const res = await app.request("/prompts/reorder", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
