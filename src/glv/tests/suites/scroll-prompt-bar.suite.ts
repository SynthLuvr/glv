import { mkdirSync } from "node:fs";
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

  // NDJSON reply lines in the flavor's dialect, committed to the store as
  // they stream — the same preview→committed churn a real agent run puts
  // the transcript through.
  const REPLY_TEXTS = [
    "First streamed chunk of the reply.",
    "Second streamed chunk of the reply, a bit longer so the tail grows.",
    "Third and final chunk of the reply.",
  ];
  const STREAM_LINES = REPLY_TEXTS.map((text) => fx.streamLine(text));

  beforeAll(async () => {
    env = await fx.startEnv("glv-scroll-", {
      lines: STREAM_LINES,
      writeDb: true,
      lineDelayMs: 500,
      sleepMs: 500,
    });
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
      {
        id: "scroll-follow",
        name: "Scroll Placement",
        // The follow-up test submits a prompt, so the working dir must
        // exist — the runner spawns the agent with it as its cwd.
        workingDir: join(env.scratchDir, "follow"),
      },
    ]);
    fx.seedMessages(env, "scroll-fold", MESSAGES);
    fx.seedMessages(env, "scroll-end", MESSAGES);
    fx.seedMessages(env, "scroll-follow", MESSAGES);
    mkdirSync(join(env.scratchDir, "follow"), { recursive: true });
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

  describe("follow-up submit", () => {
    it("keeps the reader at the tail instead of stranding them mid-transcript", async () => {
      await withPage(env.context, async (page) => {
        const { bar, pane } = await openSession(page, "scroll-follow");

        // The user reaches the composer by scrolling to the end; submitting
        // swaps the pane with new cards (submitted prompt, queue, live tail)
        // below the old offset. The reader must ride to the new bottom —
        // an absolute restore leaves them stranded with the composer below
        // the fold while the run's output grows even further away.
        await pane.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await bar.locator(".prompt-input").fill("Follow-up prompt");
        await bar.locator(".send-btn").click();

        // Wait out the run: the busy bar appears, streams its reply through
        // the preview→committed handoff, and yields back to Send. The
        // anchoring drift the old code stranded the reader with plays out
        // during this churn — so judge the position only once it settled.
        await expect(
          page.locator("[data-prompt-bar] .status-hint.running"),
        ).toBeVisible({ timeout: 15000 });
        await expect(
          page.locator("[data-prompt-bar] .status-hint.running"),
        ).toBeHidden({ timeout: 30000 });
        await page.waitForTimeout(1000);

        const distance = await pane.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        );
        expect(distance).toBeLessThan(160);
        const edges = await verticalEdges(bar);
        const paneEdges = await verticalEdges(pane);
        expect(edges.top).toBeLessThan(paneEdges.bottom);
      });
    });
  });
};

export { runScrollPromptBarSuite };
