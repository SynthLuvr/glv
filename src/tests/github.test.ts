import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GhClient, RepoInfo } from "../gh.js";
import type { ProcessResult, SpawnFn } from "../runner/index.js";
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

const STUB_REPOS: RepoInfo[] = [
  {
    nameWithOwner: "SynthLuvr/goose-log-viewer",
    visibility: "PUBLIC",
    isFork: false,
    updatedAt: "2026-07-17T12:00:00Z",
    description: "Viewer for goose sessions",
  },
  {
    nameWithOwner: "SynthLuvr/goose",
    visibility: "PUBLIC",
    isFork: true,
    updatedAt: "2026-07-16T10:00:00Z",
    description: null,
  },
  {
    nameWithOwner: "SynthLuvr/private-app",
    visibility: "PRIVATE",
    isFork: false,
    updatedAt: "2026-07-15T08:00:00Z",
    description: "Secret project",
  },
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

const extractJobId = (html: string): string | undefined =>
  html.match(/\/github\/clone-status\/(clone_[a-z0-9_]+)/)?.[1];

const createStubGh = (
  opts: {
    materialiseDelayMs?: number;
    materialiseError?: string;
    listError?: string;
  } = {},
): GhClient => ({
  listRepos: async () => {
    if (opts.listError !== undefined) throw new Error(opts.listError);
    return STUB_REPOS;
  },
  listBranches: async () => {
    if (opts.listError !== undefined) throw new Error(opts.listError);
    return { branches: ["main", "develop"], defaultBranch: "main" };
  },
  materialise: async () => {
    if (opts.materialiseDelayMs !== undefined)
      await sleep(opts.materialiseDelayMs);
    if (opts.materialiseError !== undefined)
      throw new Error(opts.materialiseError);
  },
});

type GithubSpawnState = {
  spawn: SpawnFn;
  insertedIds: string[];
};

const createGithubSpawn = (
  db: DatabaseSync,
  lines: string[] = [],
  delayMs = 50,
): GithubSpawnState => {
  const insertedIds: string[] = [];
  let pidCounter = 70000;
  let counter = 0;

  const spawn: SpawnFn = (_binary, _args, opts) => {
    const pid = ++pidCounter;
    const local = { killed: false };
    let resolveExit!: (r: ProcessResult) => void;
    const exit = new Promise<ProcessResult>((resolve) => {
      resolveExit = resolve;
    });

    const id = `gh-${Date.now()}-${++counter}`;
    insertedIds.push(id);
    db.prepare(
      "INSERT INTO sessions (id, name, session_type, working_dir) " +
        "VALUES (?, ?, 'user', ?)",
    ).run(id, `gh-session-${counter}`, opts.cwd);

    const stdout = (async function* () {
      for (const line of lines) {
        if (local.killed) return;
        if (delayMs > 0) await sleep(delayMs);
        yield line;
      }
      if (!local.killed) resolveExit({ exitCode: 0 });
    })();

    const kill = (signal?: string) => {
      if (local.killed) return;
      local.killed = true;
      resolveExit({ exitCode: null, signal: signal ?? "SIGTERM" });
    };

    return { pid, kill, stdout, exit };
  };

  return { spawn, insertedIds };
};

// Polls clone-status until the response is no longer a CloningView (i.e. the
// transcript or an error form has been returned).
const pollCloneStatus = async (
  app: ReturnType<typeof createApp>,
  jobId: string,
  maxAttempts = 40,
): Promise<{ status: number; html: string }> => {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await app.request(`/github/clone-status/${jobId}`, {
      headers: { "HX-Request": "true" },
    });
    const html = await res.text();
    if (!html.includes("clone-spinner")) return { status: res.status, html };
    await sleep(50);
  }
  const res = await app.request(`/github/clone-status/${jobId}`, {
    headers: { "HX-Request": "true" },
  });
  return { status: res.status, html: await res.text() };
};

let db: DatabaseSync;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-gh-test-"));
  db = new DatabaseSync(join(dir, "sessions.db"));
  db.exec(SCHEMA);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const makeApp = (
  gh: GhClient,
  spawn?: SpawnFn,
  opts: { pollTimeoutMs?: number } = {},
): ReturnType<typeof createApp> =>
  createApp(db, createRunner(DEFAULT_RUNNER_CONFIG, spawn), {
    gh,
    pollTimeoutMs: opts.pollTimeoutMs,
  });

describe("GET /github/repos", () => {
  it("returns the repo list as JSON sorted by last-push desc", async () => {
    const app = makeApp(createStubGh());
    const res = await app.request("/github/repos");
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.repos).toHaveLength(3);
    expect(data.repos[0].nameWithOwner).toBe("SynthLuvr/goose-log-viewer");
    expect(data.repos[1].nameWithOwner).toBe("SynthLuvr/goose");
    expect(data.repos[2].nameWithOwner).toBe("SynthLuvr/private-app");
  });

  it("returns ok:false with an error message when gh fails", async () => {
    const app = makeApp(createStubGh({ listError: "Could not authenticate" }));
    const res = await app.request("/github/repos");
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Could not authenticate");
  });
});

describe("GET /github/repos/:owner/:repo/branches", () => {
  it("returns branches and the default branch", async () => {
    const app = makeApp(createStubGh());
    const res = await app.request(
      "/github/repos/SynthLuvr/goose-log-viewer/branches",
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.branches).toContain("main");
    expect(data.branches).toContain("develop");
    expect(data.defaultBranch).toBe("main");
  });
});

describe("NewSessionForm source toggle", () => {
  it("renders both source segments with the toggle", async () => {
    const app = makeApp(createStubGh());
    const html = await (await app.request("/sessions/new")).text();
    expect(html).toContain("source-toggle");
    expect(html).toContain('data-source="working_dir"');
    expect(html).toContain('data-source="github"');
    expect(html).toContain("Working Directory");
    expect(html).toContain("GitHub Repository");
  });

  it("defaults to working directory with github body hidden", async () => {
    const app = makeApp(createStubGh());
    const html = await (await app.request("/sessions/new")).text();
    expect(html).toContain('name="source" value="working_dir"');
    // GitHub body carries source-hidden when working_dir is selected
    const githubIdx = html.indexOf('data-source-body="github"');
    expect(githubIdx).toBeGreaterThan(-1);
    const beforeGithub = html.slice(Math.max(0, githubIdx - 100), githubIdx);
    expect(beforeGithub).toContain("source-hidden");
  });

  it("includes the source-picker client script", async () => {
    const app = makeApp(createStubGh());
    const html = await (await app.request("/sessions/new")).text();
    expect(html).toContain('src="/assets/source-picker.js"');
  });
});

describe("POST /sessions (github validation)", () => {
  it("rejects a missing repo with the github source preserved", async () => {
    const app = makeApp(createStubGh());
    const { status, html } = await postForm(app, "/sessions", {
      source: "github",
      prompt: "build it",
    });
    expect(status).toBe(422);
    expect(html).toContain("repository and branch are required");
    expect(html).toContain('name="source" value="github"');
  });

  it("rejects an invalid repo format", async () => {
    const app = makeApp(createStubGh());
    const { status, html } = await postForm(app, "/sessions", {
      source: "github",
      repo: "not-a-valid-repo",
      branch: "main",
      prompt: "hello",
    });
    expect(status).toBe(422);
    expect(html).toContain("Invalid repository format");
  });

  it("rejects an empty prompt and keeps github values", async () => {
    const app = makeApp(createStubGh());
    const { status, html } = await postForm(app, "/sessions", {
      source: "github",
      repo: "owner/repo",
      branch: "main",
      prompt: "  ",
    });
    expect(status).toBe(422);
    expect(html).toContain("prompt is required");
    expect(html).toContain('name="source" value="github"');
  });
});

describe("POST /sessions (github clone flow)", () => {
  it("starts a clone and returns the cloning view immediately", async () => {
    const app = makeApp(createStubGh({ materialiseDelayMs: 5000 }));
    const { status, html } = await postForm(app, "/sessions", {
      source: "github",
      repo: "SynthLuvr/app1",
      branch: "main",
      prompt: "build it",
    });
    expect(status).toBe(200);
    expect(html).toContain("cloning-view");
    expect(html).toContain("Cloning");
    expect(html).toContain("SynthLuvr/app1");
    expect(html).toContain("clone-status");
  });

  it("transitions to the transcript when clone and goose succeed", async () => {
    const { spawn, insertedIds } = createGithubSpawn(db, ["line1"]);
    const gh = createStubGh();
    const app = makeApp(gh, spawn, { pollTimeoutMs: 5000 });

    const { html: cloningHtml } = await postForm(app, "/sessions", {
      source: "github",
      repo: "SynthLuvr/flow-test",
      branch: "main",
      prompt: "build it",
    });
    const jobId = extractJobId(cloningHtml);
    expect(jobId).toBeDefined();

    const { status, html } = await pollCloneStatus(app, jobId!);
    expect(status).toBe(200);
    expect(insertedIds).toHaveLength(1);
    expect(html).toContain(`data-session-id="${insertedIds[0]}"`);
    expect(html).toContain("build it");
    expect(html).toContain("hx-swap-oob");
  });

  it("shows the error form when the clone fails", async () => {
    const gh = createStubGh({
      materialiseError: "repository not found",
    });
    const app = makeApp(gh);

    const { html: cloningHtml } = await postForm(app, "/sessions", {
      source: "github",
      repo: "SynthLuvr/missing",
      branch: "main",
      prompt: "hello",
    });
    const jobId = extractJobId(cloningHtml);
    expect(jobId).toBeDefined();

    const { status, html } = await pollCloneStatus(app, jobId!);
    expect(status).toBe(422);
    expect(html).toContain("repository not found");
    expect(html).toContain("new-session");
  });
});

describe("working directory mode (unchanged)", () => {
  it("rejects an empty prompt", async () => {
    const app = makeApp(createStubGh());
    const { status, html } = await postForm(app, "/sessions", {
      prompt: "  ",
      working_dir: dir,
    });
    expect(status).toBe(422);
    expect(html).toContain("prompt is required");
  });

  it("rejects a non-existent working directory", async () => {
    const app = makeApp(createStubGh());
    const { status, html } = await postForm(app, "/sessions", {
      prompt: "hello",
      working_dir: "/no/such/dir/anywhere",
    });
    expect(status).toBe(422);
    expect(html).toContain("does not exist");
  });
});
