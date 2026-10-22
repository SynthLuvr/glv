import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The shell is a fixed-height .app whose only scrollers are the sidebar and
// the detail pane — the document itself must never scroll. Both pages
// embedding the hidden upload input are covered: its containing block (see
// form[data-upload-form] in app.css) decides whether it escapes the shell's
// overflow clipping and grows a second, document-level scrollbar beside
// .detail's — visible with classic scrollbars, silently scrollable with
// overlay ones.
const runSingleScrollbarSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  // Tall enough that the prompt bar lands far below the fold.
  const messages = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Transcript line ${i}. `.repeat(24) }],
  }));

  beforeAll(async () => {
    env = await fx.startEnv("glv-single-scrollbar-");
    fx.seedSessions(env, [
      {
        id: "scroll-doc",
        name: "Long Transcript",
        workingDir: join(env.scratchDir, "doc-project"),
      },
    ]);
    fx.seedMessages(env, "scroll-doc", messages);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const documentOverflow = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollHeight - el.clientHeight;
    });

  it("keeps the document unscrollable on a long transcript", async () => {
    await withPage(env.context, async (page) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${env.baseUrl}/sessions/${fx.viewId("scroll-doc")}`);
      await page.locator("form.prompt-bar").waitFor();

      expect(await documentOverflow(page)).toBeLessThanOrEqual(0);

      // The one real scroller still scrolls internally.
      const paneOverflow = await page
        .locator("#detail-pane")
        .evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(paneOverflow).toBeGreaterThan(0);
    });
  });

  it("keeps the new-session page unscrollable at short heights", async () => {
    await withPage(env.context, async (page) => {
      await page.setViewportSize({ width: 1280, height: 600 });
      await page.goto(env.baseUrl);
      await page.locator("form.new-session-form").waitFor();

      expect(await documentOverflow(page)).toBeLessThanOrEqual(0);

      // This form sits near the top, so the document check alone would
      // pass even without the fix — the containing-block guard is what
      // pins the invariant here.
      const position = await page
        .locator("form.new-session-form")
        .evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe("relative");
    });
  });
};

export { runSingleScrollbarSuite };
