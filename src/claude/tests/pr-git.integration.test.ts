import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type IntegrationEnv,
  insertMessages,
  insertSessions,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

const PR_URL = "https://github.com/owner/repo/pull/35";
let env: IntegrationEnv;

beforeAll(async () => {
  env = await startIntegrationEnv("glv-prgit-");
  insertSessions(env.dbs.projectsDir, [
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
  insertMessages(env.dbs.projectsDir, "pr-sess", [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          content: [{ type: "text", text: PR_URL }],
          is_error: false,
        },
      ],
    },
  ]);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

describe("PR chip in the transcript", () => {
  it("renders a chip linking the detected PR in the header", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl + "/sessions/pr-sess");
      const chip = page.locator(".session-header .pr-chip");
      await expect(chip).toHaveAttribute("href", PR_URL);
      await expect(chip).toContainText("#35");
    });
  });

  it("renders no header chip for a session without a PR", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl + "/sessions/plain-sess");
      await expect(page.locator(".session-header .pr-chip")).toHaveCount(0);
    });
  });
});

describe("PR state endpoint", () => {
  it("resolves the PR state via mocked gh", async () => {
    const res = await authedFetch(
      env,
      "/sessions/pr-sess/pr-state?url=" + encodeURIComponent(PR_URL),
    );
    expect(res.status).toBe(200);
    // PR 35 is not mapped in gh-mock-script.ts, so it defaults to OPEN.
    const html = await res.text();
    expect(html).toContain("pr-state-open");
    expect(html).toContain("Open");
  });

  it("returns an empty body for a non-PR url", async () => {
    const res = await authedFetch(
      env,
      "/sessions/pr-sess/pr-state?url=https://evil.example/x",
    );
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("");
  });
});

describe("git-info endpoint", () => {
  it("resolves the branch via gh but omits worktree for a non-repo dir", async () => {
    const res = await authedFetch(env, "/sessions/pr-sess/git-info");
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
