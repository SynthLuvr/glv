import { join } from "node:path";
import { expect } from "@playwright/test";
import { execa } from "execa";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
} from "../harness.js";

// Exercises PR detection across every candidate rank in pr.ts through the
// sidebar-meta routes, plus rank precedence when several appear in one
// session. `gh` on PATH is the harness's state-mocked script
// (gh-mock-script.ts); the working dir is a real git repository so the
// branch chip resolves through real git.

const OPEN_URL = "https://github.com/owner/repo/pull/201";

const runPrChipsSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const git = async (cwd: string, ...args: string[]): Promise<void> => {
    await execa("git", ["-C", cwd, ...args]);
  };

  const meta = (id: string): Promise<Response> =>
    authedFetch(env, `/sessions/${id}/sidebar-meta`);

  beforeAll(async () => {
    env = await fx.startEnv("glv-prchips-");

    // A real repo on the branch the mocked gh reports for PR 201.
    const repoDir = join(env.scratchDir, "repo");
    await execa("git", ["init", "-b", "main", repoDir]);
    await git(repoDir, "config", "user.email", "t@t.com");
    await git(repoDir, "config", "user.name", "T");
    await git(repoDir, "commit", "--allow-empty", "-m", "init");
    await git(repoDir, "branch", "feat-201");
    await git(
      repoDir,
      "worktree",
      "add",
      join(env.scratchDir, "wt"),
      "feat-201",
    );

    fx.seedSessions(env, [
      { id: "pr-created", name: "Created", workingDir: repoDir },
      { id: "pr-mcp", name: "MCP", workingDir: repoDir },
      { id: "pr-summary", name: "Summary", workingDir: repoDir },
      { id: "pr-mention", name: "Mention", workingDir: repoDir },
      { id: "pr-thinking", name: "Thinking", workingDir: repoDir },
      { id: "pr-precedence", name: "Precedence", workingDir: repoDir },
      { id: "pr-none", name: "None", workingDir: repoDir },
      {
        id: "pr-plain",
        name: "Plain",
        workingDir: join(env.scratchDir, "no-git"),
      },
    ]);

    // An MCP tool result carrying the PR nested in a JSON payload (here
    // wrapped in the code-execution envelope pr.ts recovers it from).
    const mcpJson = JSON.stringify({
      items: [{ html_url: "https://github.com/owner/repo/pull/205" }],
    });
    const mcpText = `Code Executed Successfully.\n# Return Value\n\`\`\`json\n${mcpJson}\n\`\`\``;

    fx.seedMessages(env, "pr-created", [
      { role: "user", content: [fx.toolResponse(OPEN_URL, false)] },
    ]);
    fx.seedMessages(env, "pr-mcp", [
      { role: "user", content: [fx.toolResponse(mcpText, false)] },
    ]);
    fx.seedMessages(env, "pr-summary", [
      {
        role: "assistant",
        content: [{ type: "text", text: `Opened ${OPEN_URL} for review.` }],
      },
    ]);
    fx.seedMessages(env, "pr-mention", [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "please rebase onto https://github.com/owner/repo/pull/203",
          },
        ],
      },
    ]);
    fx.seedMessages(env, "pr-thinking", [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "maybe related to https://github.com/owner/repo/pull/202",
          },
        ],
      },
    ]);
    // Rank precedence: assistant summary (3) beats user mention (4).
    fx.seedMessages(env, "pr-precedence", [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "see https://github.com/owner/repo/pull/204 first",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Done — ${OPEN_URL}.` }],
      },
    ]);
    fx.seedMessages(env, "pr-none", [
      { role: "user", content: [{ type: "text", text: "no links here" }] },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("pr detection ranks", () => {
    it.each([
      { id: "pr-created", url: OPEN_URL },
      { id: "pr-mcp", url: "https://github.com/owner/repo/pull/205" },
      { id: "pr-summary", url: OPEN_URL },
      { id: "pr-mention", url: "https://github.com/owner/repo/pull/203" },
      { id: "pr-thinking", url: "https://github.com/owner/repo/pull/202" },
    ])("renders a PR chip for $id", async ({ id, url }) => {
      const res = await meta(id);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("pr-chip");
      expect(html).toContain(url);
    });

    it("prefers the assistant summary over an earlier user mention", async () => {
      const res = await meta("pr-precedence");
      const html = await res.text();
      expect(html).toContain(OPEN_URL);
      expect(html).not.toContain("pull/204");
    });

    it("renders no chip for a session without PR links", async () => {
      const res = await meta("pr-none");
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("pr-chip");
    });

    it("404s the per-session meta for an unknown session", async () => {
      expect((await meta("nope")).status).toBe(404);
    });

    it("resolves every session's meta in one bulk request", async () => {
      const res = await authedFetch(env, "/sessions/sidebar-meta");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="sidebar-meta-pr-created"');
      expect(html).toContain("pull/205");
      expect(html).toContain("pull/202");
      // Every session gets a slot; the PR-less one renders an empty span.
      const none = /id="sidebar-meta-pr-none"[^>]*><\/span>/.exec(html);
      expect(none).not.toBeNull();
    });

    it("resolves the branch and worktree through the git-info route", async () => {
      const res = await authedFetch(env, "/sessions/pr-created/git-info");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("git-chip-branch");
      expect(html).toContain("feat-201");
      expect(html).toContain("git-chip-worktree");
    });

    it("returns an empty git-info body for a session without a PR", async () => {
      const res = await authedFetch(env, "/sessions/pr-none/git-info");
      expect(res.status).toBe(200);
      expect((await res.text()).trim()).toBe("");
    });
  });
};

export { runPrChipsSuite };
