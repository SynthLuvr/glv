import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type IntegrationEnv,
  insertMessages,
  insertSessions,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

let env: IntegrationEnv;

// A transcript tall enough to overflow the detail pane at a mobile viewport so
// the scroll-to-latest button appears and scroll behaviour is exercised.
const TALL_MESSAGES = Array.from({ length: 50 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: [{ type: "text", text: `Line ${i}.\n`.repeat(8) }],
}));

beforeAll(async () => {
  env = await startIntegrationEnv("glv-mobile-layout-");
  insertSessions(env.dbs.sessionsDb, [
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
  insertMessages(env.dbs.sessionsDb, "mobile-tall", TALL_MESSAGES);
  insertMessages(env.dbs.sessionsDb, "mobile-tall-2", TALL_MESSAGES);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

// The detail pane is the default on mobile when a session is selected.
const openMobileDetail = async (
  page: import("@playwright/test").Page,
  id = "mobile-tall",
): Promise<void> => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`${env.baseUrl}/sessions/${id}`);
  await expect(page.locator("#detail-pane")).toBeVisible();
};

// Reads the toggle bar's box straight from the DOM — more reliable than
// Playwright's locator.boundingBox(), which can yield null for actionability.
const toggleRect = async (
  page: import("@playwright/test").Page,
): Promise<{ top: number; bottom: number; display: string } | null> =>
  page.evaluate(() => {
    const el = document.querySelector(".mobile-pane-toggle");
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      display: getComputedStyle(el).display,
    };
  });

describe("mobile scroll-to-latest button", () => {
  it("hides while the sidebar pane is active (it is a detail-pane affordance)", async () => {
    await withPage(env.context, async (page) => {
      await openMobileDetail(page);

      const scrollBtn = page.locator("#scroll-latest");
      // Loaded at the top of a long, idle transcript → not near the bottom, so
      // the floating button is shown.
      await expect(scrollBtn).toBeVisible();

      // Switch to the session list: the detail pane is hidden via CSS, so the
      // floating button must hide too instead of floating over the list.
      await page.locator('.mobile-pane-btn[data-pane="sidebar"]').click();
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

      await page.locator('.mobile-pane-btn[data-pane="sidebar"]').click();
      await expect(scrollBtn).toBeHidden();
      await page.locator('.mobile-pane-btn[data-pane="detail"]').click();
      // Back on the detail pane, still scrolled to the top → button returns.
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

      // Scroll the detail pane to its very bottom.
      await pane.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });

      const rect = await toggleRect(page);
      expect(rect).not.toBeNull();
      expect(rect!.display).toBe("flex");
      // The top bar stays flush to the top and fully within the viewport.
      expect(rect!.top).toBeGreaterThanOrEqual(-0.5);
      expect(rect!.bottom).toBeLessThanOrEqual(800);

      // The page itself never scrolls — only the inner pane does. This is the
      // invariant overscroll containment + the dynamic viewport height protect.
      const bodyScroll = await page.evaluate(
        () => document.body.scrollTop + document.documentElement.scrollTop,
      );
      expect(bodyScroll).toBe(0);

      // The shell fills the real viewport (dynamic viewport height).
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
      await page.locator('.mobile-pane-btn[data-pane="sidebar"]').click();
      await page
        .locator('.session-item[data-session-id="mobile-tall-2"] .session-name')
        .click();
      await expect(page).toHaveURL(`${env.baseUrl}/sessions/mobile-tall-2`);

      const rect = await toggleRect(page);
      expect(rect).not.toBeNull();
      expect(rect!.display).toBe("flex");
      expect(rect!.top).toBeGreaterThanOrEqual(-0.5);
      expect(rect!.bottom).toBeLessThanOrEqual(800);
    });
  }, 30000);
});
