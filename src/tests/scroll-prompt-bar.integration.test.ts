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

beforeAll(async () => {
  env = await startIntegrationEnv("glv-scroll-");
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

// The prompt bar uses `position: sticky; bottom: 0` inside the scrolling
// transcript pane. Its containing block is the wrapper's content box, so any
// wrapper padding-bottom lifts the bar off the viewport's bottom edge once the
// reader scrolls to the very end — the bar should stay pegged flush instead.
describe("sticky prompt bar", () => {
  it("stays flush to the bottom edge when scrolled to the end of a long transcript", async () => {
    insertSessions(env.dbs.sessionsDb, [
      {
        id: "scroll-flush",
        name: "Scroll Flush",
        workingDir: join(env.scratchDir, "scroll"),
      },
    ]);
    // Many tall messages so the transcript overflows the viewport.
    const tall = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `Line ${i}.\n`.repeat(10) }],
    }));
    insertMessages(env.dbs.sessionsDb, "scroll-flush", tall);

    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/scroll-flush`);
      await expect(page.locator("[data-prompt-bar]")).toBeVisible();
      const pane = page.locator("#detail-pane");

      // Sanity: the transcript must actually overflow so scrolling is real.
      const overflow = await pane.evaluate(
        (el) => el.scrollHeight - el.clientHeight,
      );
      expect(overflow).toBeGreaterThan(200);

      // Scroll the transcript to the very bottom.
      await pane.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });

      // Gap between the prompt bar's bottom edge and the pane's bottom edge.
      // With the bug (wrapper padding-bottom) the bar lifts off the bottom;
      // once pegged flush the gap is ~0.
      const gap = await page.evaluate(() => {
        const bar = document.querySelector("[data-prompt-bar]");
        const detail = document.getElementById("detail-pane");
        if (bar === null || detail === null) return Number.POSITIVE_INFINITY;
        return (
          detail.getBoundingClientRect().bottom -
          bar.getBoundingClientRect().bottom
        );
      });
      expect(gap).toBeLessThan(5);
    });
  });
});
