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
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const openDetail = async (page: Page, id = "mp-a"): Promise<void> => {
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${env.baseUrl}/sessions/${fx.viewId(id)}`);
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
      .locator(
        `.session-item[data-session-id="${fx.viewId(id)}"] .session-name`,
      )
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

    // Regression: history restore (Back/Forward) swaps the whole body, so
    // the pane toggle's listener died with the old bar — the tabs stopped
    // responding until reload — and the snapshot replayed the pane frozen at
    // push time, burying the list after going Back.
    it("keeps the pane tabs working after a history restore", async () => {
      await withPage(env.context, async (page) => {
        await page.setViewportSize(VIEWPORT);
        // Enter the session via the list: a direct /sessions/<id> goto has
        // no in-app history entry to restore.
        await page.goto(`${env.baseUrl}/`);
        await selectSession(page, "mp-a");
        await expect(page.locator(".app")).toHaveAttribute(
          "data-mobile-pane",
          "detail",
        );
        await page.goBack();
        // The restore round-trips a cache-miss fetch, so allow more than
        // the default timeout.
        await expect(page.locator(".app")).toHaveAttribute(
          "data-mobile-pane",
          "sidebar",
          { timeout: 10000 },
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
