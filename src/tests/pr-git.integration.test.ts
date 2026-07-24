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
  insertSessions(env.dbs.sessionsDb, [
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
  insertMessages(env.dbs.sessionsDb, "pr-sess", [
    {
      role: "user",
      content: [
        {
          type: "toolResponse",
          toolResult: {
            value: {
              content: [{ type: "text", text: PR_URL }],
              isError: false,
            },
          },
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
  it("degrades to an empty body when gh cannot resolve state", async () => {
    const res = await authedFetch(
      env,
      "/sessions/pr-sess/pr-state?url=" + encodeURIComponent(PR_URL),
    );
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("");
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
  it("returns an empty body when no branch can be resolved", async () => {
    const res = await authedFetch(env, "/sessions/pr-sess/git-info");
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("");
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
