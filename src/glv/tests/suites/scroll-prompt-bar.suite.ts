import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runScrollPromptBarSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  // Tall enough that the composer starts well below the fold.
  const MESSAGES = Array.from({ length: 50 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Line ${i}.\n`.repeat(10) }],
  }));

  beforeAll(async () => {
    env = await fx.startEnv("glv-scroll-");
    fx.seedSessions(env, [
      {
        id: "scroll-fold",
        name: "Scroll Placement",
        workingDir: join(env.scratchDir, "scroll"),
      },
      {
        id: "scroll-end",
        name: "Scroll Placement",
        workingDir: join(env.scratchDir, "scroll"),
      },
    ]);
    fx.seedMessages(env, "scroll-fold", MESSAGES);
    fx.seedMessages(env, "scroll-end", MESSAGES);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const openSession = async (
    page: Page,
    id: string,
  ): Promise<{ bar: Locator; pane: Locator }> => {
    await page.goto(`${env.baseUrl}/sessions/${fx.viewId(id)}`);
    const bar = page.locator("[data-prompt-bar]");
    const pane = page.locator("#detail-pane");
    await expect(bar).toBeVisible();
    return { bar, pane };
  };

  // DOMRect edges are prototype getters that do not survive Playwright's
  // return serialization — copy them out inside the page.
  const verticalEdges = async (
    locator: Locator,
  ): Promise<{ top: number; bottom: number }> =>
    locator.evaluate((el) => {
      const { top, bottom } = el.getBoundingClientRect();
      return { top, bottom };
    });

  describe("in-flow prompt bar", () => {
    it("sits below the fold instead of over the contents", async () => {
      await withPage(env.context, async (page) => {
        const { bar, pane } = await openSession(page, "scroll-fold");

        // The transcript must overflow for the placement to be meaningful.
        const overflow = await pane.evaluate(
          (el) => el.scrollHeight - el.clientHeight,
        );
        expect(overflow).toBeGreaterThan(200);

        await pane.evaluate((el) => {
          el.scrollTop = 0;
        });
        // A pinned bar would sit inside the view, over the contents.
        expect((await verticalEdges(bar)).top).toBeGreaterThan(
          (await verticalEdges(pane)).bottom,
        );
      });
    });

    it("closes the page when scrolled to the bottom", async () => {
      await withPage(env.context, async (page) => {
        const { bar, pane } = await openSession(page, "scroll-end");
        await pane.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });

        const barEdges = await verticalEdges(bar);
        const paneEdges = await verticalEdges(pane);
        expect(barEdges.top).toBeGreaterThan(paneEdges.top);
        expect(barEdges.bottom).toBeLessThan(paneEdges.bottom);
        // The wrapper's bottom padding stays under the bar; the old pinned
        // layout zeroed it to hug the pane's edge.
        expect(paneEdges.bottom - barEdges.bottom).toBeGreaterThan(40);
      });
    });
  });
};

export { runScrollPromptBarSuite };
