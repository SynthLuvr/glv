import { mkdirSync } from "node:fs";
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
    // sleepMs keeps the composer test's follow-up run "running" so the busy
    // bar (Queue/Stop) stays up while its layout is measured.
    env = await fx.startEnv("glv-mobile-layout-", { sleepMs: 20000 });
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
      {
        id: "mobile-composer",
        name: "Mobile Composer",
        workingDir: join(env.scratchDir, "composer"),
      },
      {
        id: "mobile-composer-idle",
        name: "Mobile Composer Idle",
        workingDir: join(env.scratchDir, "composer-idle"),
      },
    ]);
    fx.seedMessages(env, "mobile-tall", TALL_MESSAGES);
    fx.seedMessages(env, "mobile-tall-2", TALL_MESSAGES);
    mkdirSync(join(env.scratchDir, "composer"), { recursive: true });
    mkdirSync(join(env.scratchDir, "composer-idle"), { recursive: true });
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const openMobileDetail = async (
    page: Page,
    id = "mobile-tall",
  ): Promise<void> => {
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
            `.session-item[data-session-id="${fx.viewId("mobile-tall-2")}"] .session-name`,
          )
          .click();
        // A contended auth-db busy wait can stretch the navigation past
        // Playwright's 5s default, so allow a full lock window.
        await expect(page).toHaveURL(
          `${env.baseUrl}/sessions/${fx.viewId("mobile-tall-2")}`,
          {
            timeout: 15_000,
          },
        );

        await expectTopBarWithinViewport(page);
      });
    }, 30000);
  });

  // The busy composer packs the picker, textarea, attach and location
  // buttons, and Queue/Stop into one flex row. The textarea was the only
  // flexible item, so a phone's width deficit used to collapse it to a
  // couple of characters. Assert real geometry at a phone viewport: a
  // typing-usable textarea and a row that never overflows horizontally.
  describe("prompt bar stays usable on mobile", () => {
    const composerGeometry = async (
      page: Page,
    ): Promise<{ inputWidth: number; overflow: number } | null> =>
      page.evaluate(() => {
        const row = document.querySelector(".prompt-input-row");
        const input = document.querySelector(".prompt-input-row .prompt-input");
        if (row === null || input === null) return null;
        return {
          inputWidth: input.getBoundingClientRect().width,
          overflow: row.scrollWidth - row.clientWidth,
        };
      });

    it("keeps the follow-up textarea usable while Queue/Stop are shown", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page, "mobile-composer");
        await page
          .locator('form.prompt-bar textarea[name="prompt"]')
          .fill("Queue a follow-up while the run finishes");
        await page.locator("form.prompt-bar button.send-btn").click();

        // Submitting swaps the bar to its busy form.
        await page
          .locator("form.prompt-bar button.stop-btn")
          .waitFor({ timeout: 20000 });

        const rect = await composerGeometry(page);
        expect(rect).not.toBeNull();
        // Collapsed, the textarea measured a couple of characters wide; it
        // must keep room for a sentence.
        expect(rect!.inputWidth).toBeGreaterThan(150);
        expect(rect!.overflow).toBeLessThanOrEqual(1);
      });
    }, 60000);

    it("keeps the idle textarea usable next to its Send button", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page, "mobile-composer-idle");

        const rect = await composerGeometry(page);
        expect(rect).not.toBeNull();
        expect(rect!.inputWidth).toBeGreaterThan(200);
        expect(rect!.overflow).toBeLessThanOrEqual(1);
      });
    }, 30000);
  });
};

export { runMobileLayoutSuite };
