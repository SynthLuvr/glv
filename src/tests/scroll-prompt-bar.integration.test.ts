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

describe("sticky prompt bar", () => {
  it("stays flush to the bottom edge when scrolled to the end of a long transcript", async () => {
    // Regression: a non-zero wrapper padding-bottom lifts the sticky prompt bar
    // off the viewport's bottom edge — it must stay pegged flush to the end.
    insertSessions(env.dbs.sessionsDb, [
      {
        id: "scroll-flush",
        name: "Scroll Flush",
        workingDir: join(env.scratchDir, "scroll"),
      },
    ]);
    insertMessages(
      env.dbs.sessionsDb,
      "scroll-flush",
      Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Line ${i}.\n`.repeat(10) }],
      })),
    );

    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/scroll-flush`);

      const bar = page.locator("[data-prompt-bar]");
      const pane = page.locator("#detail-pane");
      await expect(bar).toBeVisible();

      // The transcript must overflow for the scroll to be meaningful.
      const overflow = await pane.evaluate(
        (el) => el.scrollHeight - el.clientHeight,
      );
      expect(overflow).toBeGreaterThan(200);

      await pane.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });

      // Pegged flush: the bar's bottom edge should sit at the pane's bottom edge.
      const gap =
        (await pane.evaluate((el) => el.getBoundingClientRect().bottom)) -
        (await bar.evaluate((el) => el.getBoundingClientRect().bottom));
      expect(gap).toBeLessThan(5);
    });
  });
});
