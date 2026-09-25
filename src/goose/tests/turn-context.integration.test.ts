import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type IntegrationEnv, withPage } from "../../glv/tests/harness.js";
import { gooseFixture } from "./integration-harness.js";

// Mirrors how goose actually injects the block (verified against a real
// sessions.db): its own user message whose single text item is nothing but
// the <turn-context>…</turn-context> block, trailing newline included.
const TURN_CONTEXT_TEXT = `<turn-context>
<current-time>2026-08-22 11:37:00 +02:00</current-time>
<working-directory>/home/regan/goose-log-viewer</working-directory>

ALWAYS batch multiple tool operations into ONE execute_typescript call.

</turn-context>
`;

const TURN_CONTEXT_LATER = TURN_CONTEXT_TEXT.replace(
  "2026-08-22 11:37:00 +02:00",
  "2026-08-22 11:42:00 +02:00",
);

describe("turn-context categorization", () => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await gooseFixture.startEnv("glv-turn-context-");
    gooseFixture.seedSessions(env, [
      {
        id: "t-ctx",
        name: "Turn Context",
        workingDir: join(env.scratchDir, "ctx"),
      },
    ]);
    // Verified against a real sessions.db: goose appends the context block
    // after its turn's prompt, sometimes in the same second. Turn one shares
    // one timestamp between prompt and context on purpose so the rowid
    // tiebreak keeps the prompt first; turn two uses distinct timestamps.
    const t0 = 1_787_391_465;
    gooseFixture.seedMessages(env, "t-ctx", [
      {
        role: "user",
        createdTimestamp: t0,
        content: [
          {
            type: "text",
            text: "Categorize `<turn-context>` into something other than Prompt.",
          },
        ],
      },
      {
        role: "user",
        createdTimestamp: t0,
        content: [{ type: "text", text: TURN_CONTEXT_TEXT }],
      },
      {
        role: "assistant",
        createdTimestamp: t0 + 5,
        content: [{ type: "text", text: "On it." }],
      },
      {
        role: "user",
        createdTimestamp: t0 + 60,
        content: [{ type: "text", text: "Real prompt" }],
      },
      {
        role: "user",
        createdTimestamp: t0 + 62,
        content: [{ type: "text", text: TURN_CONTEXT_LATER }],
      },
      {
        role: "assistant",
        createdTimestamp: t0 + 65,
        content: [{ type: "text", text: "Done." }],
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("tags a standalone turn-context block as CONTEXT, not PROMPT", async () => {
    const url = `${env.baseUrl}/sessions/${gooseFixture.viewId("t-ctx")}`;
    await withPage(env.context, async (page) => {
      await page.goto(url);
      const context = page.locator("article.message.context");
      await expect(context).toHaveCount(2);
      await expect(context.first().locator(".tag")).toHaveText("◇ CONTEXT");
      await expect(context.first()).toContainText("<working-directory>");
    });
  });

  it("collapses turn-context blocks by default, like tool activity", async () => {
    const url = `${env.baseUrl}/sessions/${gooseFixture.viewId("t-ctx")}`;
    await withPage(env.context, async (page) => {
      await page.goto(url);
      const block = page
        .locator("article.message.context details.block.context")
        .first();
      await expect(block).toHaveCount(1);
      await expect(block.locator("summary .block-label")).toHaveText(
        "Turn context",
      );
      await expect(block.locator("summary .block-preview")).toHaveText(
        "2026-08-22 11:37:00 +02:00",
      );
      await expect(block).not.toHaveAttribute("open");
      await expect(block.locator("pre")).toContainText("<working-directory>");
    });
  });

  it("renders the prompt ahead of the context goose appends after it", async () => {
    const url = `${env.baseUrl}/sessions/${gooseFixture.viewId("t-ctx")}`;
    await withPage(env.context, async (page) => {
      await page.goto(url);
      const articles = page.locator("article.message");
      await expect(articles.nth(0)).toHaveClass(/prompt/);
      await expect(articles.nth(1)).toHaveClass(/context/);
      await expect(articles.nth(3)).toHaveClass(/prompt/);
      await expect(articles.nth(4)).toHaveClass(/context/);
      await expect(articles.nth(0)).toContainText(
        "Categorize `<turn-context>`",
      );
    });
  });

  it("keeps prompts that merely mention the tag as PROMPT", async () => {
    const url = `${env.baseUrl}/sessions/${gooseFixture.viewId("t-ctx")}`;
    await withPage(env.context, async (page) => {
      await page.goto(url);
      const prompts = page.locator("article.message.prompt");
      await expect(prompts).toHaveCount(2);
      await expect(prompts.first()).toContainText(
        "Categorize `<turn-context>`",
      );
    });
  });
});
