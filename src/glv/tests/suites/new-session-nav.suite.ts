import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// Navigation-state regression suite: the sidebar's detail-pane swaps must
// keep the URL in step with what is on screen. The plus button historically
// swapped the New Session form in without pushing /sessions/new, so the
// address bar kept pointing at the last-viewed session — a refresh then
// "took the user back" to it.
const runNewSessionNavSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let workDir: string;

  beforeAll(async () => {
    env = await fx.startEnv("glv-nav-", { sessionName: "Nav Suite Session" });
    workDir = join(env.scratchDir, "project");
    mkdirSync(workDir, { recursive: true });
    fx.seedSessions(env, [
      {
        id: "nav-seed",
        name: "Nav Seed",
        workingDir: join(env.scratchDir, "seed"),
      },
    ]);
    fx.seedMessages(env, "nav-seed", [
      { role: "user", content: [{ type: "text", text: "seed message" }] },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("new session navigation state", () => {
    it("pushes /sessions/new when the plus button is clicked", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/nav-seed`);
        await expect(page.locator(".session-title")).toBeVisible();

        await page.locator(".new-session-btn").click();
        await expect(page.locator("form.new-session-form")).toBeVisible();
        await expect(page).toHaveURL(/\/sessions\/new$/);
      });
    }, 30000);

    it("pushes the new session's URL once it starts", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/new`);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        await page.locator('input[name="working_dir"]').fill(workDir);
        await page.locator('textarea[name="prompt"]').fill("nav suite run");
        await page.locator("button.send-btn").click();

        await page
          .locator("button.archive-btn")
          .waitFor({ state: "visible", timeout: 20000 });

        const id = await page.evaluate(() =>
          document
            .querySelector("#detail-pane [data-session-id]")
            ?.getAttribute("data-session-id"),
        );
        expect(id).toBeTruthy();
        await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
      });
    }, 45000);

    it("pushes /sessions/new after archiving", async () => {
      await withPage(env.context, async (page) => {
        page.on("dialog", (dialog) => void dialog.accept());
        await page.goto(`${env.baseUrl}/sessions/nav-seed`);
        await expect(page.locator("button.archive-btn")).toBeVisible();

        await page.locator("button.archive-btn").click();
        await expect(page.locator("form.new-session-form")).toBeVisible();
        await expect(page).toHaveURL(/\/sessions\/new$/);
      });
    }, 30000);
  });
};

export { runNewSessionNavSuite };
