import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runPrGitSuite = (fx: FlavorFixture): void => {
  const PR_URL = "https://github.com/owner/repo/pull/35";
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-prgit-");
    fx.seedSessions(env, [
      {
        id: "pr-sess",
        name: "PR Session",
        workingDir: join(env.scratchDir, "pr"),
      },
      {
        id: "plain-sess",
        name: "Plain",
        workingDir: join(env.scratchDir, "plain"),
      },
    ]);
    fx.seedMessages(env, "pr-sess", [
      {
        role: "user",
        content: [fx.toolResponse(PR_URL, false)],
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("PR chip in the transcript", () => {
    it("renders a chip linking the detected PR in the header", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl + `/sessions/${fx.viewId("pr-sess")}`);
        const chip = page.locator(".session-header .pr-chip");
        await expect(chip).toHaveAttribute("href", PR_URL);
        await expect(chip).toContainText("#35");
      });
    });

    it("renders no header chip for a session without a PR", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl + `/sessions/${fx.viewId("plain-sess")}`);
        await expect(page.locator(".session-header .pr-chip")).toHaveCount(0);
      });
    });
  });

  describe("PR chip in the sidebar", () => {
    // Browser-driven because the failure is client-side: htmx resolves
    // `hx-target` as a CSS selector, and the `:` in a namespaced session id
    // ("goose:…") made it throw, so the loading dot never got swapped out.
    it("swaps the resolved state into the sidebar PR chip", async () => {
      await withPage(env.context, async (page) => {
        const sessionId = fx.viewId("pr-sess");
        const pageErrors: string[] = [];
        page.on("pageerror", (err) => pageErrors.push(err.message));
        await page.goto(env.baseUrl + `/sessions/${sessionId}`);
        const badge = page.locator(
          `.session-item[data-session-id="${sessionId}"] .pr-chip .pr-state`,
        );
        await expect(badge).toHaveClass(/pr-state-open/, { timeout: 15000 });
        await expect(badge).toContainText("Open");
        const selectorErrors = pageErrors.filter((message) =>
          message.includes("not a valid selector"),
        );
        expect(selectorErrors).toEqual([]);
      });
    });
  });

  describe("PR state endpoint", () => {
    it("resolves the PR state via mocked gh", async () => {
      const res = await authedFetch(
        env,
        `/sessions/${fx.viewId("pr-sess")}/pr-state?url=` +
          encodeURIComponent(PR_URL),
      );
      expect(res.status).toBe(200);
      // PR 35 is not mapped in gh-mock-script.ts, so it defaults to OPEN.
      const html = await res.text();
      expect(html).toContain("pr-state-open");
      expect(html).toContain("Open");
    });
  });

  describe("git-info endpoint", () => {
    it("resolves the branch via gh but omits worktree for a non-repo dir", async () => {
      const res = await authedFetch(
        env,
        `/sessions/${fx.viewId("pr-sess")}/git-info`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      // gh-mock-script returns feat-35 for PR 35.
      expect(html).toContain("feat-35");
      expect(html).toContain("git-chip-branch");
      // The session's working_dir is not a git repo, so no worktree chip.
      expect(html).not.toContain("git-chip-worktree");
    });
  });

  describe("sidebar-meta endpoint", () => {
    it("renders a compact PR chip for sessions that created a PR", async () => {
      const res = await authedFetch(env, "/sessions/sidebar-meta");
      const html = await res.text();
      expect(html).toContain("#35");
      expect(html).toContain("pr-chip-sm");
    });
  });
};

export { runPrGitSuite };
