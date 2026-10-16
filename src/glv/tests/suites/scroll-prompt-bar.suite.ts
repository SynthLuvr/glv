import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runScrollPromptBarSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-scroll-");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const seedLongTranscript = (id: string): void => {
    fx.seedSessions(env, [
      {
        id,
        name: "Scroll Placement",
        workingDir: join(env.scratchDir, "scroll"),
      },
    ]);
    fx.seedMessages(
      env,
      id,
      Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Line ${i}.\n`.repeat(10) }],
      })),
    );
  };

  describe("in-flow prompt bar", () => {
    it("sits below the fold instead of over the contents", async () => {
      // Regression: the composer used to pin itself to the bottom of the
      // viewport, floating on top of the transcript. In flow it waits at
      // the end of the page, fully below the fold, while the contents
      // scroll past it — never under it.
      seedLongTranscript("scroll-fold");

      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("scroll-fold")}`);

        const bar = page.locator("[data-prompt-bar]");
        const pane = page.locator("#detail-pane");
        await expect(bar).toBeVisible();

        // The transcript must overflow for the placement to be meaningful.
        const overflow = await pane.evaluate(
          (el) => el.scrollHeight - el.clientHeight,
        );
        expect(overflow).toBeGreaterThan(200);

        await pane.evaluate((el) => {
          el.scrollTop = 0;
        });
        const barTop = await bar.evaluate(
          (el) => el.getBoundingClientRect().top,
        );
        const paneBottom = await pane.evaluate(
          (el) => el.getBoundingClientRect().bottom,
        );
        // Below the fold: the bar's top edge starts past the pane's
        // bottom edge — pinned placement would put it inside the view.
        expect(barTop).toBeGreaterThan(paneBottom);
      });
    });

    it("closes the page when scrolled to the bottom", async () => {
      // Regression: the wrapper's bottom padding used to be zeroed so the
      // pinned composer could hug the pane's edge; in flow the padding
      // stays and the composer reads as ordinary end-of-page content.
      seedLongTranscript("scroll-end");

      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("scroll-end")}`);

        const bar = page.locator("[data-prompt-bar]");
        const pane = page.locator("#detail-pane");
        await expect(bar).toBeVisible();

        await pane.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });

        const barRect = await bar.evaluate((el) => ({
          top: el.getBoundingClientRect().top,
          bottom: el.getBoundingClientRect().bottom,
        }));
        const paneRect = await pane.evaluate((el) => ({
          top: el.getBoundingClientRect().top,
          bottom: el.getBoundingClientRect().bottom,
        }));
        // Fully in view at the end, but not pegged flush to the pane's
        // edge — the wrapper's bottom padding stays under it.
        expect(barRect.top).toBeGreaterThan(paneRect.top);
        expect(barRect.bottom).toBeLessThan(paneRect.bottom);
        expect(paneRect.bottom - barRect.bottom).toBeGreaterThan(40);
      });
    });
  });
};

export { runScrollPromptBarSuite };
