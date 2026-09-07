import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runMobilePaneToggleSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  const VIEWPORT = { width: 400, height: 800 };

  beforeAll(async () => {
    env = await fx.startEnv("glv-mobile-pane-");
    fx.seedSessions(env, [
      { id: "mp-a", name: "Pane A", workingDir: join(env.scratchDir, "a") },
      { id: "mp-b", name: "Pane B", workingDir: join(env.scratchDir, "b") },
    ]);
    fx.seedMessages(env, "mp-a", [
      { role: "user", content: [{ type: "text", text: "seed a" }] },
    ]);
    fx.seedMessages(env, "mp-b", [
      { role: "user", content: [{ type: "text", text: "seed b" }] },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const openDetail = async (page: Page, id = "mp-a"): Promise<void> => {
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${env.baseUrl}/sessions/${id}`);
    await expect(page.locator("#detail-pane")).toBeVisible();
  };

  const switchPane = async (
    page: Page,
    pane: "sidebar" | "detail",
  ): Promise<void> => {
    await page.locator(`.mobile-pane-btn[data-pane="${pane}"]`).click();
  };

  const selectSession = async (page: Page, id: string): Promise<void> => {
    await page
      .locator(`.session-item[data-session-id="${id}"] .session-name`)
      .click();
  };

  describe("mobile pane toggle", () => {
    // Regression: clicking Sessions must keep the session list visible even
    // when a #detail-pane swap (here a deliberately slowed session-select GET)
    // lands afterwards. Previously the htmx:afterSwap handler unconditionally
    // forced the pane back to "detail", so the button appeared dead.
    it("stays on the sidebar when a detail-pane swap lands after clicking Sessions", async () => {
      await withPage(env.context, async (page) => {
        await page.route("**/sessions/mp-b", async (route) => {
          await new Promise((r) => setTimeout(r, 600));
          await route.continue();
        });
        await openDetail(page, "mp-a");
        await switchPane(page, "sidebar");
        // Start the (delayed) navigation, then immediately switch back.
        await selectSession(page, "mp-b");
        await switchPane(page, "sidebar");
        // Let the delayed swap land.
        await page.waitForTimeout(1200);
        await expect(page.locator(".app")).toHaveAttribute(
          "data-mobile-pane",
          "sidebar",
        );
      });
    }, 30000);

    it("switches to the detail pane when a session is tapped from the sidebar", async () => {
      await withPage(env.context, async (page) => {
        await openDetail(page, "mp-a");
        await switchPane(page, "sidebar");
        await selectSession(page, "mp-b");
        await expect(page.locator(".app")).toHaveAttribute(
          "data-mobile-pane",
          "detail",
        );
      });
    }, 30000);

    // Regression: htmx history restoration (Back/Forward) swaps the whole
    // body, so the pane toggle's DOMContentLoaded listener died with the old
    // bar — the Sessions/Detail tabs stopped responding until a reload. The
    // init now re-runs on restore, and the pane is re-derived from the
    // restored URL: the snapshot froze "detail" (captured after the
    // click-time switch), which buried the list after going Back.
    it("keeps the pane tabs working after a history restore", async () => {
      await withPage(env.context, async (page) => {
        await openDetail(page, "mp-a");
        await page.goBack();
        // The restored snapshot froze pane="detail"; the fix re-derives
        // "sidebar" from the restored URL (the session list).
        await expect(page.locator(".app")).toHaveAttribute(
          "data-mobile-pane",
          "sidebar",
        );
        await switchPane(page, "detail");
        await expect(page.locator(".app")).toHaveAttribute(
          "data-mobile-pane",
          "detail",
        );
        await switchPane(page, "sidebar");
        await expect(page.locator("#session-list")).toBeVisible();
      });
    }, 30000);
  });
};

export { runMobilePaneToggleSuite };
