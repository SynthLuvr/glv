import { realpathSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { execa } from "execa";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
} from "../harness.js";

const runGhGitSuite = (fx: FlavorFixture): void => {
  // PR numbers select the mocked `gh` response — see gh-mock-script.ts.
  const OPEN_URL = "https://github.com/owner/repo/pull/201";
  const MERGED_URL = "https://github.com/owner/repo/pull/202";
  const CLOSED_URL = "https://github.com/owner/repo/pull/203";
  const GIT_PR_URL = "https://github.com/owner/repo/pull/204";
  const GIT_BRANCH = "feat-204";

  let env: IntegrationEnv;
  let worktreeDir: string;

  const git = async (cwd: string, ...args: string[]): Promise<void> => {
    await execa("git", ["-C", cwd, ...args]);
  };

  // A tool result whose text is a bare PR URL is how detectPrUrl spots a
  // session-created PR.
  const prContent = (url: string): unknown => [fx.toolResponse(url, false)];

  beforeAll(async () => {
    env = await fx.startEnv("glv-ghgit-");

    // Real repo with a worktree on the branch gh-mock reports for PR 204.
    const repoDir = join(env.scratchDir, "repo");
    await execa("git", ["init", "-b", "main", repoDir]);
    await git(repoDir, "config", "user.email", "t@t.com");
    await git(repoDir, "config", "user.name", "T");
    await git(repoDir, "commit", "--allow-empty", "-m", "init");

    worktreeDir = join(env.scratchDir, "wt-204");
    await git(repoDir, "worktree", "add", "-b", GIT_BRANCH, worktreeDir);

    fx.seedSessions(env, [
      { id: "git-sess", name: "Git Session", workingDir: worktreeDir },
      { id: "repo-sess", name: "Repo Session", workingDir: repoDir },
      {
        id: "plain-sess",
        name: "Plain",
        workingDir: join(env.scratchDir, "no-git"),
      },
    ]);

    fx.seedMessages(env, "git-sess", [
      { role: "user", content: prContent(GIT_PR_URL) },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("pr-state endpoint with mocked gh", () => {
    it.each([
      { url: OPEN_URL, cls: "pr-state-open", label: "Open" },
      { url: MERGED_URL, cls: "pr-state-merged", label: "Merged" },
      { url: CLOSED_URL, cls: "pr-state-closed", label: "Closed" },
    ])("renders the $label PR-state badge", async ({ url, cls, label }) => {
      const res = await authedFetch(
        env,
        `/sessions/plain-sess/pr-state?url=${encodeURIComponent(url)}`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(cls);
      expect(html).toContain(label);
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
      expect(html).toContain(GIT_BRANCH);
      expect(html).toContain("git-chip-branch");
      expect(html).toContain("git-chip-worktree");
      // git's porcelain output normalizes to forward slashes even on
      // Windows and may additionally resolve 8.3 short TEMP paths to
      // their long form, so accept any canonical spelling of the dir.
      const worktreeVariants = [worktreeDir].flatMap((dir) => {
        const spellings = [dir, dir.replaceAll("\\", "/")];
        try {
          const real = realpathSync
            .native(dir)
            .replace(/^\\\\\?\\UNC\\/, "//")
            .replace(/^\\\\\?\\/, "");
          spellings.push(real, real.replaceAll("\\", "/"));
        } catch {
          // The literal spellings still apply.
        }
        return spellings;
      });
      const htmlLower = html.toLowerCase();
      expect(
        worktreeVariants.some((dir) => htmlLower.includes(dir.toLowerCase())),
      ).toBe(true);
    });

    it("returns an empty body for a session without a PR", async () => {
      const res = await authedFetch(env, "/sessions/repo-sess/git-info");
      expect(res.status).toBe(200);
      expect((await res.text()).trim()).toBe("");
    });
  });
};

export { runGhGitSuite };
