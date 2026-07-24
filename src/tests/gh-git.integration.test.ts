import { join } from "node:path";
import { expect } from "@playwright/test";
import { execa } from "execa";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type IntegrationEnv,
  insertMessages,
  insertSessions,
  startIntegrationEnv,
} from "./integration-harness";

// PR numbers map deterministically to gh-mock-script.ts states so one server
// instance exercises every branch of the state machine.
const OPEN_URL = "https://github.com/owner/repo/pull/201";
const MERGED_URL = "https://github.com/owner/repo/pull/202";
const CLOSED_URL = "https://github.com/owner/repo/pull/203";
const GIT_PR_URL = "https://github.com/owner/repo/pull/204";

// gh-mock-script.ts derives the branch from the PR number: feat-<N>.
const GIT_BRANCH = "feat-204";

let env: IntegrationEnv;
let worktreeDir: string;

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  await execa("git", ["-C", cwd, ...args]);
};

beforeAll(async () => {
  env = await startIntegrationEnv("glv-ghgit-");

  // Build a real repo with a worktree on the branch gh-mock reports for PR 204.
  const repoDir = join(env.scratchDir, "repo");
  await execa("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.email", "t@t.com");
  await git(repoDir, "config", "user.name", "T");
  await git(repoDir, "commit", "--allow-empty", "-m", "init");

  worktreeDir = join(env.scratchDir, "wt-204");
  await git(repoDir, "worktree", "add", "-b", GIT_BRANCH, worktreeDir);

  insertSessions(env.dbs.sessionsDb, [
    {
      id: "git-sess",
      name: "Git Session",
      workingDir: worktreeDir,
    },
    {
      id: "repo-sess",
      name: "Repo Session",
      workingDir: repoDir,
    },
    {
      id: "plain-sess",
      name: "Plain",
      workingDir: join(env.scratchDir, "no-git"),
    },
  ]);

  // The tool response with a bare PR URL is how detectPrUrl recognises a
  // session-created PR.
  const prContent = (url: string): unknown => [
    {
      type: "toolResponse",
      toolResult: {
        value: { content: [{ type: "text", text: url }], isError: false },
      },
    },
  ];

  insertMessages(env.dbs.sessionsDb, "git-sess", [
    { role: "user", content: prContent(GIT_PR_URL) },
  ]);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

describe("pr-state endpoint with mocked gh", () => {
  it("resolves OPEN and renders the Open badge", async () => {
    const res = await authedFetch(
      env,
      `/sessions/plain-sess/pr-state?url=${encodeURIComponent(OPEN_URL)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pr-state-open");
    expect(html).toContain("Open");
  });

  it("resolves MERGED and renders the Merged badge", async () => {
    const res = await authedFetch(
      env,
      `/sessions/plain-sess/pr-state?url=${encodeURIComponent(MERGED_URL)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pr-state-merged");
    expect(html).toContain("Merged");
  });

  it("resolves CLOSED and renders the Closed badge", async () => {
    const res = await authedFetch(
      env,
      `/sessions/plain-sess/pr-state?url=${encodeURIComponent(CLOSED_URL)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pr-state-closed");
    expect(html).toContain("Closed");
  });

  it("returns an empty body for a non-PR url", async () => {
    const res = await authedFetch(
      env,
      "/sessions/plain-sess/pr-state?url=https://evil.example/x",
    );
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("");
  });
});

describe("git-info endpoint with mocked gh and real git", () => {
  it("resolves the branch via gh and the worktree via git", async () => {
    const res = await authedFetch(env, "/sessions/git-sess/git-info");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Branch chip from gh headRefName → git worktree lookup.
    expect(html).toContain(GIT_BRANCH);
    expect(html).toContain("git-chip-branch");
    // Worktree chip pointing at the local checkout.
    expect(html).toContain("git-chip-worktree");
    expect(html).toContain(worktreeDir);
  });

  it("returns an empty body for a session without a PR", async () => {
    const res = await authedFetch(env, "/sessions/repo-sess/git-info");
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("");
  });
});

describe("sidebar resolveBranches with real git runner", () => {
  it("renders a branch chip for a session inside a git worktree", async () => {
    const res = await authedFetch(env, "/sessions/git-sess/sidebar-meta");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(GIT_BRANCH);
    expect(html).toContain("git-chip-sm");
  });

  it("renders no branch chip for a session outside a git repo", async () => {
    const res = await authedFetch(env, "/sessions/plain-sess/sidebar-meta");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("git-chip");
  });
});
