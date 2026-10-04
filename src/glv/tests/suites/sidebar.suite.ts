import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runSidebarSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-sidebar-");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("sidebar — session list visibility", () => {
    it("shows an empty state when the database has no sessions", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);

        await expect(page.locator(".sidebar .empty")).toBeVisible();
        await expect(page.locator(".empty")).toContainText("No sessions found");
        await expect(page.locator("#session-list")).toHaveCount(0);
        await expect(page.locator(".session-item")).toHaveCount(0);
        await expect(page.locator(".session-count")).toHaveText("0");
      });
    });

    it("shows sessions in the sidebar once they exist in the database", async () => {
      fx.seedSessions(env, [
        {
          id: "sidebar-alpha",
          name: "Alpha Session",
          workingDir: join(env.scratchDir, "alpha"),
        },
        {
          id: "sidebar-beta",
          name: "Beta Session",
          workingDir: join(env.scratchDir, "beta"),
        },
      ]);

      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);

        await expect(page.locator("#session-list")).toBeVisible();
        await expect(page.locator(".sidebar .empty")).toHaveCount(0);
        await expect(page.locator(".session-item")).toHaveCount(2);
        await expect(page.locator("#session-list")).toContainText(
          "Alpha Session",
        );
        await expect(page.locator("#session-list")).toContainText(
          "Beta Session",
        );
        await expect(page.locator(".session-count")).toHaveText("2");
      });
    });
  });
};

export { runSidebarSuite };
