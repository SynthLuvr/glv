import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type IntegrationEnv, withPage } from "../../glv/tests/harness.js";
import { gooseFixture } from "./integration-harness.js";

// Mirrors what goose writes when a resumed session's replayed history is
// compacted (verified against a real sessions.db): user-role messages
// shaped [thinking, text] — the model's reasoning about the summary plus
// the compacted text.
const compactedSummary = (thinking: string, text: string) => [
  { type: "thinking", thinking, signature: "sig-compact" },
  { type: "text", text },
];

describe("compacted-summary categorization", () => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await gooseFixture.startEnv("glv-summary-");
    gooseFixture.seedSessions(env, [
      {
        id: "t-summary",
        name: "Compacted Summary",
        workingDir: join(env.scratchDir, "summary"),
      },
    ]);
    const t0 = 1_787_391_465;
    gooseFixture.seedMessages(env, "t-summary", [
      {
        role: "user",
        createdTimestamp: t0,
        content: [{ type: "text", text: "Refactor this git worktree" }],
      },
      {
        role: "user",
        createdTimestamp: t0 + 10,
        content: compactedSummary(
          "The tool call was a shell command running git status. I should " +
            "summarize this concisely.",
          "A shell command checked the git repository state. Result: on " +
            "branch chore/x, clean working tree.",
        ),
      },
      {
        role: "user",
        createdTimestamp: t0 + 20,
        content: compactedSummary(
          "The user wants me to summarize a tool call and response pair.",
          "A shell command was run to show a git diff stat between main " +
            "and HEAD. The output shows 31 files changed.",
        ),
      },
      {
        role: "assistant",
        createdTimestamp: t0 + 30,
        content: [{ type: "text", text: "Baseline is green." }],
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("tags user-role thinking summaries as SUMMARY, not PROMPT", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/t-summary`);
      const summaries = page.locator("article.message.summary");
      await expect(summaries).toHaveCount(2);
      await expect(summaries.first().locator(".tag")).toHaveText("◌ SUMMARY");
      const prompts = page.locator("article.message.prompt");
      await expect(prompts).toHaveCount(1);
      await expect(prompts.first()).toContainText("Refactor this git worktree");
    });
  });

  it("keeps the summary text visible with thinking collapsed inside", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/t-summary`);
      const first = page.locator("article.message.summary").first();
      await expect(first.locator(".message-text").first()).toContainText(
        "A shell command checked the git repository state",
      );
      const thinking = first.locator("details.block.thinking");
      await expect(thinking).toHaveCount(1);
      await expect(thinking).not.toHaveAttribute("open");
      await expect(thinking.locator(".block-content")).toContainText(
        "summarize this concisely",
      );
    });
  });

  it("orders the transcript prompt, summaries, then output", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/t-summary`);
      const articles = page.locator("article.message");
      await expect(articles).toHaveCount(4);
      await expect(articles.nth(0)).toHaveClass(/prompt/);
      await expect(articles.nth(1)).toHaveClass(/summary/);
      await expect(articles.nth(2)).toHaveClass(/summary/);
      await expect(articles.nth(3)).toHaveClass(/output/);
    });
  });
});
