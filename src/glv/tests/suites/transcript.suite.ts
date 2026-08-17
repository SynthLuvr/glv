import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runTranscriptSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-transcript-");
    fx.seedSessions(env, [
      {
        id: "t-rich",
        name: "Rich Transcript",
        workingDir: join(env.scratchDir, "rich"),
      },
    ]);
    fx.seedMessages(env, "t-rich", [
      { role: "user", content: [{ type: "text", text: "Build the project" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done. It is **bold** now." }],
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me consider the steps" }],
      },
      {
        role: "assistant",
        content: [fx.toolRequest("shell", { command: "echo hi" })],
      },
      {
        role: "user",
        content: [fx.toolResponse("ok", false)],
      },
      {
        role: "user",
        content: [fx.toolResponse("boom", true)],
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const open = async (run: (page: Page) => Promise<void>): Promise<void> =>
    withPage(env.context, async (page) => {
      await page.goto(env.baseUrl + "/sessions/t-rich");
      await run(page);
    });

  describe("transcript readability", () => {
    it("renders assistant text as sanitized markdown", async () => {
      await open(async (page) => {
        await expect(page.locator(".markdown").first()).toContainText("bold");
        expect(await page.locator("#messages").innerHTML()).not.toContain(
          "<script>",
        );
      });
    });

    it("adds a copy-as-markdown button to the user prompt", async () => {
      await open(async (page) => {
        await expect(
          page.locator('.copy-md-btn[data-md="Build the project"]'),
        ).toBeVisible();
      });
    });

    it("surfaces reasoning in collapsible thinking blocks", async () => {
      await open(async (page) => {
        await expect(page.locator(".block.thinking")).toContainText("Thinking");
        await expect(
          page.locator(".block.thinking .block-content"),
        ).toContainText("Let me consider the steps");
      });
    });

    it("renders tool calls with name and arguments", async () => {
      await open(async (page) => {
        await expect(page.locator(".block.tool-call .tool-name")).toHaveText(
          "shell",
        );
        await expect(page.locator(".block.tool-call pre")).toContainText(
          "echo hi",
        );
      });
    });

    it("renders tool results and flags error results distinctly", async () => {
      await open(async (page) => {
        const success = page.locator(".block.tool-result:not(.is-error)");
        await expect(success.first()).toContainText("Result");
        await expect(success.first().locator("pre")).toContainText("ok");
        const errorResult = page.locator(".block.tool-result.is-error");
        await expect(errorResult.first()).toContainText("Error result");
        await expect(errorResult.first().locator("pre")).toContainText("boom");
      });
    });

    it("tags tool results as tool activity, not prompts", async () => {
      await open(async (page) => {
        await expect(page.locator(".message.tool")).toHaveCount(2);
        await expect(
          page.locator(".message.tool .tag.tool").first(),
        ).toContainText("TOOL");
        await expect(page.locator(".message.prompt")).toHaveCount(1);
        const outputs = await page.locator(".message.output").count();
        expect(outputs).toBeGreaterThanOrEqual(2);
      });
    });
  });
};

export { runTranscriptSuite };
