import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// Error results are block content like any other: collapsed until opened.
// And because a tall error body sits at the transcript tail, it is also the
// canary for scroll memory: the copy-button enhancement used to drop the
// block-body height cap a frame after load, so a restored offset clamped
// against the shorter first layout — stranding the reader mid-transcript
// and overwriting the saved offset with the clamped value. The suite seeds
// the saved offset the way the debounced save writes it, so it stays
// deterministic on hosts whose headless compositor never dispatches scroll
// events.

const runErrorResultsSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  const FILLER = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Line ${i}. ${"filler ".repeat(20)}` }],
  }));

  // Taller than the stylesheet's block-body cap (26rem) so losing the cap
  // moves the pane the way the bug report describes.
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
  const REOPEN = 300;

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

  // Simulates a prior visit's debounced save: reads the offset "scrolled to
  // the bottom" produces (what the save stores) and the localStorage key the
  // client derives from the rendered session root, then writes it — awaited,
  // so the write can't race the next navigation.
  const seedScrollAtBottom = async (page: Page): Promise<number> =>
    page.evaluate(async (waitMs) => {
      const pane = document.getElementById("detail-pane");
      const id = document
        .querySelector("#detail-pane [data-session-id]")
        ?.getAttribute("data-session-id");
      if (pane === null || id === null) throw new Error("no session root");
      await new Promise((resolve) => {
        window.setTimeout(resolve, waitMs);
      });
      const maxScroll = pane.scrollHeight - pane.clientHeight;
      localStorage.setItem(`glv:scroll:${id}`, String(maxScroll));
      return maxScroll;
    }, REOPEN);

  it("renders error results collapsed by default", async () => {
    await withPage(env.context, async (page) => {
      await openSession(page);
      const error = page.locator("details.tool-result.is-error");
      await expect(error).toHaveCount(1);
      await expect(error).not.toHaveAttribute("open");
      // Collapsed, not gone — one click reveals the body.
      await expect(error.locator("summary .block-label")).toHaveText(
        "Error result",
      );
      await expect(error.locator("pre")).toContainText("Boom");
      // A healthy result is collapsed too — same treatment.
      await expect(
        page.locator("details.tool-result:not(.is-error)"),
      ).not.toHaveAttribute("open");
    });
  });

  it("keeps the block-body cap after the copy-button wrapper lands", async () => {
    await withPage(env.context, async (page) => {
      await openSession(page);
      const pre = page.locator("details.tool-result.is-error pre");
      // The enhancement wraps every pre shortly after load; once it lands,
      // the pre sits inside .code-block — where the cap must still hold,
      // or the pane grows after the scroll restore has already run.
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
        .toStrictEqual({ wrapped: true, height: 416, capped: true });
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
        .poll(
          () =>
            pane.evaluate((el) => ({
              top: Math.round(el.scrollTop),
              fromBottom: Math.round(
                el.scrollHeight - el.scrollTop - el.clientHeight,
              ),
            })),
          { timeout: 5000 },
        )
        .toStrictEqual({
          top: maxScroll,
          fromBottom: 0,
        });
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
        .poll(
          () =>
            pane.evaluate((el) =>
              Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
            ),
          { timeout: 5000 },
        )
        .toBe(0);
    });
  });
};

export { runErrorResultsSuite };
