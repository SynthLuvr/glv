import { mkdirSync } from "node:fs";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runGroupRunningIndicatorSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const post = (
    path: string,
    body: Record<string, string>,
  ): Promise<Response> =>
    authedFetch(env, path, {
      method: "POST",
      body: new URLSearchParams(body),
      headers: { "HX-Request": "true" },
    });

  beforeAll(async () => {
    // A long sleep keeps the mock agent running long enough to observe the
    // running state, then it exits so the "done" transition is testable too.
    env = await fx.startEnv("glv-group-run-", { sleepMs: 6000 });
    for (const id of ["grp-a", "grp-b"])
      mkdirSync(env.scratchDir + "/" + id, { recursive: true });
    fx.seedSessions(env, [
      {
        id: "grp-a",
        name: "Group Run A",
        workingDir: env.scratchDir + "/grp-a",
      },
      {
        id: "grp-b",
        name: "Group Run B",
        workingDir: env.scratchDir + "/grp-b",
      },
    ]);
    // Two sessions must share a group to render a collapsible group header.
    await post(`/sessions/${fx.viewId("grp-a")}/group-with`, {
      otherId: fx.viewId("grp-b"),
    });
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("group running indicator", () => {
    it("mirrors a member's run state on the group header", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const header = page.locator(".session-group .group-header");
        const dot = page.locator(".session-group .group-header .run-dot");
        await expect(header).toBeVisible();

        // Idle to start: no group indicator and no member is running.
        await expect(header).not.toHaveAttribute("data-running", "");
        await expect(dot).toBeHidden();

        // Starting a run on one member drives both its own card and the group
        // header live, via the status feed's EventSource.
        await post(`/sessions/${fx.viewId("grp-a")}/prompt`, {
          prompt: "do work",
        });
        await expect(
          page.locator(
            `.session-item[data-session-id="${fx.viewId("grp-a")}"]`,
          ),
        ).toHaveAttribute("data-running", "");
        await expect(
          page.locator(
            `.session-item[data-session-id="${fx.viewId("grp-b")}"]`,
          ),
        ).not.toHaveAttribute("data-running", "");
        await expect(header).toHaveAttribute("data-running", "");
        await expect(dot).toBeVisible();

        // Once the run finishes the indicators clear again.
        await expect(header).not.toHaveAttribute("data-running", "", {
          timeout: 15000,
        });
        await expect(
          page.locator(
            `.session-item[data-session-id="${fx.viewId("grp-a")}"]`,
          ),
        ).not.toHaveAttribute("data-running", "");
      });
    });
  });
};

export { runGroupRunningIndicatorSuite };
