import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runNewSessionSuite = (fx: FlavorFixture): void => {
  const SESSION_NAME = "Integration Test Session";
  const PROMPT_TEXT = "Build the project and report the result.";

  let env: IntegrationEnv;
  let workDir: string;

  beforeAll(async () => {
    env = await fx.startEnv("glv-integration-", {
      sessionName: SESSION_NAME,
    });

    workDir = join(env.scratchDir, "project");
    mkdirSync(workDir, { recursive: true });

    // Seed a pre-existing session in a different working dir so the sidebar's
    // #session-list container exists for the out-of-band swap, without colliding
    // with new-session detection.
    fx.seedSessions(env, [
      {
        id: "seed-session",
        name: "Seed Project",
        workingDir: join(env.scratchDir, "other-project"),
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("new session — working directory flow", () => {
    it("loads the New Session page for an authenticated user", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();
        await expect(page.locator('textarea[name="prompt"]')).toBeVisible();
        await expect(page.locator("button.send-btn")).toHaveText(
          "Start session",
        );
      });
    });

    it(`starts a ${fx.name} session from the form`, async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        await page.locator('input[name="working_dir"]').fill(workDir);
        await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
        await page.locator("button.send-btn").click();

        // The transcript replaces the form once the agent creates the session.
        await page
          .locator("button.archive-btn")
          .waitFor({ state: "visible", timeout: 20000 });

        await expect(page.locator("#detail-pane")).toContainText(PROMPT_TEXT);

        // The sidebar refreshes out-of-band without a full page reload.
        await expect(page.locator("#session-list")).toContainText(
          SESSION_NAME,
          {
            timeout: 5000,
          },
        );

        await expect(page.locator(".status-hint.error")).toHaveCount(0);
      });
    });
  });
};

export { runNewSessionSuite };
