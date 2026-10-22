import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The shell is a fixed-height .app whose only scrollers are the sidebar and
// the detail pane — the document itself must never scroll. The prompt bar
// embeds a hidden file input (position:absolute); while its embedding form
// was static, that input's containing block was the initial containing
// block, so no ancestor's overflow clipping applied to it and — sitting at
// the bottom of a long transcript — its static position pinned the
// document's scrollable overflow to the transcript tail. The desktop page
// then grew a second, document-level scrollbar beside .detail's (visible
// with classic space-taking scrollbars, silently scrollable with overlay
// ones). These proofs pin the invariant on both pages that embed the
// upload fields.
const runSingleScrollbarSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-single-scrollbar-", {
      sessionName: "Single Scrollbar Session",
    });
    fx.seedSessions(env, [
      {
        id: "scroll-doc",
        name: "Long Transcript",
        workingDir: join(env.scratchDir, "doc-project"),
      },
    ]);
    // Tall enough that the prompt bar lands far below the fold.
    fx.seedMessages(
      env,
      "scroll-doc",
      Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Transcript line ${i}. `.repeat(24) }],
      })),
    );
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("keeps the document unscrollable on a long transcript", async () => {
    await withPage(env.context, async (page) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${env.baseUrl}/sessions/${fx.viewId("scroll-doc")}`);
      await page.locator("form.prompt-bar").waitFor();

      const doc = await page.evaluate(() => {
        const se = document.scrollingElement ?? document.documentElement;
        return { scrollHeight: se.scrollHeight, clientHeight: se.clientHeight };
      });
      // The document must not scroll — a second scrollbar here used to
      // appear next to the detail pane's on classic-scrollbar desktops.
      expect(doc.scrollHeight).toBeLessThanOrEqual(doc.clientHeight);

      // ... while the one real scroller still scrolls internally.
      const pane = await page.evaluate(() => {
        const el = document.getElementById("detail-pane");
        return {
          scrollHeight: el?.scrollHeight ?? 0,
          clientHeight: el?.clientHeight ?? 0,
        };
      });
      expect(pane.scrollHeight).toBeGreaterThan(pane.clientHeight);
    });
  });

  it("keeps the new-session page unscrollable at short heights", async () => {
    await withPage(env.context, async (page) => {
      await page.setViewportSize({ width: 1280, height: 600 });
      await page.goto(env.baseUrl);
      await page.locator("form.new-session-form").waitFor();

      const doc = await page.evaluate(() => {
        const se = document.scrollingElement ?? document.documentElement;
        return { scrollHeight: se.scrollHeight, clientHeight: se.clientHeight };
      });
      expect(doc.scrollHeight).toBeLessThanOrEqual(doc.clientHeight);

      const form = await page.evaluate(() => {
        const el = document.querySelector("form.new-session-form");
        return {
          scrollHeight: el?.scrollHeight ?? 0,
          clientHeight: el?.clientHeight ?? 0,
          position: el ? getComputedStyle(el).position : "",
        };
      });
      // The form is the hidden input's containing block — the guard the
      // static form never provided.
      expect(form.position).toBe("relative");
      expect(form.scrollHeight).toBeGreaterThanOrEqual(form.clientHeight);
    });
  });
};

export { runSingleScrollbarSuite };
