import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runMobileLayoutSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  // Tall enough to overflow the detail pane at a mobile viewport, which makes
  // the scroll-to-latest button appear and exercises scroll behaviour.
  const TALL_MESSAGES = Array.from({ length: 50 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Line ${i}.\n`.repeat(8) }],
  }));

  const VIEWPORT = { width: 400, height: 800 };

  beforeAll(async () => {
    env = await fx.startEnv("glv-mobile-layout-");
    fx.seedSessions(env, [
      {
        id: "mobile-tall",
        name: "Mobile Tall",
        workingDir: join(env.scratchDir, "mobile"),
      },
      {
        id: "mobile-tall-2",
        name: "Mobile Tall 2",
        workingDir: join(env.scratchDir, "mobile-2"),
      },
    ]);
    fx.seedMessages(env, "mobile-tall", TALL_MESSAGES);
    fx.seedMessages(env, "mobile-tall-2", TALL_MESSAGES);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const openMobileDetail = async (
    page: Page,
    id = "mobile-tall",
  ): Promise<void> => {
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

  // Read the toggle bar's box straight from the DOM rather than via
  // locator.boundingBox(), which can return null for actionability reasons.
  const expectTopBarWithinViewport = async (page: Page): Promise<void> => {
    const rect = await page.evaluate(() => {
      const el = document.querySelector(".mobile-pane-toggle");
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        display: getComputedStyle(el).display,
      };
    });
    expect(rect).not.toBeNull();
    expect(rect!.display).toBe("flex");
    // The top bar stays flush to the top and fully inside the viewport.
    expect(rect!.top).toBeGreaterThanOrEqual(-0.5);
    expect(rect!.bottom).toBeLessThanOrEqual(VIEWPORT.height);
  };

  describe("mobile scroll-to-latest button", () => {
    it("hides while the sidebar pane is active", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);
        const scrollBtn = page.locator("#scroll-latest");
        // Idle at the top of a long transcript → not near the bottom → shown.
        await expect(scrollBtn).toBeVisible();

        await switchPane(page, "sidebar");
        await expect(page.locator(".app")).toHaveAttribute(
          "data-mobile-pane",
          "sidebar",
        );
        await expect(scrollBtn).toBeHidden();
      });
    }, 30000);

    it("reappears (when not near the bottom) after returning to the detail pane", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);
        const scrollBtn = page.locator("#scroll-latest");
        await expect(scrollBtn).toBeVisible();

        await switchPane(page, "sidebar");
        await expect(scrollBtn).toBeHidden();
        await switchPane(page, "detail");
        await expect(scrollBtn).toBeVisible();
      });
    }, 30000);
  });

  describe("mobile layout stability", () => {
    it("keeps the top bar pinned and the body unscrolled while the detail pane scrolls", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);
        const pane = page.locator("#detail-pane");

        // The transcript must overflow for the scroll to be meaningful.
        const overflow = await pane.evaluate(
          (el) => el.scrollHeight - el.clientHeight,
        );
        expect(overflow).toBeGreaterThan(200);

        await pane.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });

        await expectTopBarWithinViewport(page);

        // Only the inner pane scrolls; overscroll containment keeps the body put.
        const bodyScroll = await page.evaluate(
          () => document.body.scrollTop + document.documentElement.scrollTop,
        );
        expect(bodyScroll).toBe(0);

        // The shell fills the real (dynamic) viewport height.
        const fills = await page.evaluate(() => {
          const app = document.querySelector(".app");
          if (app === null) return false;
          const style = getComputedStyle(app);
          return Math.abs(parseFloat(style.height) - window.innerHeight) < 2;
        });
        expect(fills).toBe(true);
      });
    }, 30000);

    it("keeps the top bar visible after an htmx navigation on mobile", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);
        // Navigate to the other session via the sidebar (htmx swap).
        await switchPane(page, "sidebar");
        await page
          .locator(
            '.session-item[data-session-id="mobile-tall-2"] .session-name',
          )
          .click();
        // A contended auth-db busy wait can stretch the navigation past
        // Playwright's 5s default, so allow a full lock window.
        await expect(page).toHaveURL(`${env.baseUrl}/sessions/mobile-tall-2`, {
          timeout: 15_000,
        });

        await expectTopBarWithinViewport(page);
      });
    }, 30000);
  });
};

export { runMobileLayoutSuite };
