import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// A tall error body at the transcript tail covers two regressions at once:
// error results must collapse like every other block, and the copy-button
// enhancement used to drop the block-body height cap a frame after load —
// clamping a restored scroll offset against the shorter first layout. The
// saved offset is seeded straight into localStorage, the way the debounced
// save writes it, so the suite stays deterministic on hosts whose headless
// compositor never dispatches scroll events.

const runErrorResultsSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const FILLER = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Line ${i}. ${"filler ".repeat(20)}` }],
  }));

  // Taller than the stylesheet's block-body cap so losing the cap moves
  // the pane the way the bug report describes.
  const STACK = Array.from(
    { length: 60 },
    (_, i) => `at frame ${i} in the failing code path`,
  ).join("\n");

  const MESSAGES = [
    ...FILLER,
    {
      role: "assistant",
      content: [
        fx.toolRequest("developer__shell", { cmd: "echo ok" }),
        fx.toolResponse("ok", false),
        fx.toolRequest("developer__shell", { cmd: "exit 1" }),
        fx.toolResponse(`Boom\n${STACK}`, true),
        { type: "text", text: "The command failed." },
      ],
    },
  ];

  const SESSION_ID = "err-scroll";
  // The block-body cap from app.css (.block pre { max-height: 26rem }) at
  // the 16px root font size.
  const CAPPED_HEIGHT_PX = 26 * 16;
  // Lets the post-load enhancements settle before the offset is read.
  const SETTLE_MS = 300;

  beforeAll(async () => {
    env = await fx.startEnv("glv-error-results-", {});
    fx.seedSessions(env, [
      {
        id: SESSION_ID,
        name: "Error Scroll",
        workingDir: join(env.scratchDir, "w"),
      },
    ]);
    fx.seedMessages(env, SESSION_ID, MESSAGES);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const openSession = async (page: Page): Promise<void> => {
    await page.goto(`${env.baseUrl}/sessions/${fx.viewId(SESSION_ID)}`);
    await expect(page.locator("#messages article").first()).toBeVisible();
  };

  // Seed the offset a prior visit's debounced save would have written: the
  // bottom offset of the settled layout, under the localStorage key the
  // client derives from the rendered session root. The evaluate is awaited,
  // so the write cannot race the next navigation.
  const seedScrollAtBottom = async (page: Page): Promise<number> =>
    page.evaluate(async (settleMs) => {
      const pane = document.getElementById("detail-pane");
      const id = document
        .querySelector("#detail-pane [data-session-id]")
        ?.getAttribute("data-session-id");
      if (pane === null || id === null) throw new Error("no session root");
      await new Promise((resolve) => {
        window.setTimeout(resolve, settleMs);
      });
      const maxScroll = pane.scrollHeight - pane.clientHeight;
      localStorage.setItem(`glv:scroll:${id}`, String(maxScroll));
      return maxScroll;
    }, SETTLE_MS);

  const paneMetrics = (
    pane: Locator,
  ): Promise<{ top: number; fromBottom: number }> =>
    pane.evaluate((el) => ({
      top: Math.round(el.scrollTop),
      fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    }));

  it("renders error results collapsed by default", async () => {
    await withPage(env.context, async (page) => {
      await openSession(page);
      const error = page.locator("details.tool-result.is-error");
      await expect(error).toHaveCount(1);
      await expect(error).not.toHaveAttribute("open");
      await expect(error.locator("summary .block-label")).toHaveText(
        "Error result",
      );
      await expect(error.locator("pre")).toContainText("Boom");
      await expect(
        page.locator("details.tool-result:not(.is-error)"),
      ).not.toHaveAttribute("open");
    });
  });

  it("keeps the block-body cap after the copy-button wrapper lands", async () => {
    await withPage(env.context, async (page) => {
      await openSession(page);
      const pre = page.locator("details.tool-result.is-error pre");
      // The enhancement re-parents every pre under .code-block shortly
      // after load; the cap must hold there too, or the pane grows after
      // the scroll restore has run.
      await expect
        .poll(
          () =>
            pre.evaluate((el) => ({
              wrapped:
                el.parentElement?.classList.contains("code-block") === true,
              height: Math.round(el.getBoundingClientRect().height),
              capped: getComputedStyle(el).maxHeight !== "none",
            })),
          { timeout: 5000 },
        )
        .toStrictEqual({
          wrapped: true,
          height: CAPPED_HEIGHT_PX,
          capped: true,
        });
    });
  });

  it("restores the saved scroll offset across a reload", async () => {
    await withPage(env.context, async (page) => {
      await openSession(page);
      const maxScroll = await seedScrollAtBottom(page);

      await page.reload();
      await expect(page.locator("#messages article").first()).toBeVisible();
      const pane = page.locator("#detail-pane");
      await expect
        .poll(() => paneMetrics(pane), { timeout: 5000 })
        .toStrictEqual({ top: maxScroll, fromBottom: 0 });
    });
  });

  it("restores the saved offset when navigating away and back", async () => {
    await withPage(env.context, async (page) => {
      await openSession(page);
      await seedScrollAtBottom(page);
      await page.goto(`${env.baseUrl}/`);
      await openSession(page);
      const pane = page.locator("#detail-pane");
      await expect
        .poll(async () => (await paneMetrics(pane)).fromBottom, {
          timeout: 5000,
        })
        .toBe(0);
    });
  });
};

export { runErrorResultsSuite };
