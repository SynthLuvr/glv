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
    gooseFixture.seedMessages(env, "t-ctx", [
      { role: "user", content: [{ type: "text", text: TURN_CONTEXT_TEXT }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Categorize `<turn-context>` into something other than Prompt.",
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Real prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "On it." }] },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("tags a standalone turn-context block as CONTEXT, not PROMPT", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/t-ctx`);
      const context = page.locator("article.message.context");
      await expect(context).toHaveCount(1);
      await expect(context.locator(".tag")).toHaveText("◇ CONTEXT");
      await expect(context).toContainText("<working-directory>");
    });
  });

  it("keeps prompts that merely mention the tag as PROMPT", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/t-ctx`);
      const prompts = page.locator("article.message.prompt");
      await expect(prompts).toHaveCount(2);
      await expect(prompts.first()).toContainText(
        "Categorize `<turn-context>`",
      );
    });
  });
});
