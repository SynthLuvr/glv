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
      {
        id: "t-turns",
        name: "Turned Transcript",
        workingDir: join(env.scratchDir, "turns"),
      },
    ]);
    // Two clean turns: prompt, reply, prompt, reply.
    fx.seedMessages(env, "t-turns", [
      { role: "user", content: [{ type: "text", text: "First turn" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "First reply." }],
      },
      { role: "user", content: [{ type: "text", text: "Second turn" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Second reply." }],
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
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const open = async (run: (page: Page) => Promise<void>): Promise<void> =>
    withPage(env.context, async (page) => {
      await page.goto(env.baseUrl + `/sessions/${fx.viewId("t-rich")}`);
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

  // B3: turn rhythm — a divider marks where each new turn begins, not the
  // transcript's first message, and carries a machine-readable timestamp.
  describe("turn dividers", () => {
    const openTurns = (run: (page: Page) => Promise<void>): Promise<void> =>
      withPage(env.context, async (page) => {
        await page.goto(env.baseUrl + `/sessions/${fx.viewId("t-turns")}`);
        await run(page);
      });

    it("divides the second turn only, ahead of its prompt", async () => {
      await openTurns(async (page) => {
        const dividers = page.locator(".turn-divider");
        await expect(dividers).toHaveCount(1);
        // The divider sits immediately before the second prompt message,
        // not after it and not before the first.
        const order = await page.evaluate(() =>
          Array.from(document.querySelectorAll("#messages > *")).map((el) =>
            el.classList.contains("turn-divider")
              ? "divider"
              : el.classList.contains("message")
                ? el.className
                : "other",
          ),
        );
        expect(order).toEqual([
          "message prompt",
          "message output",
          "divider",
          "message prompt",
          "message output",
        ]);
      });
    });

    it("stamps each divider with a machine-readable time", async () => {
      await openTurns(async (page) => {
        const time = page.locator(".turn-divider time");
        const datetime = await time.getAttribute("datetime");
        expect(datetime).not.toBeNull();
        expect(datetime).toContain("T");
        await expect(time).not.toBeEmpty();
      });
    });
  });
};

export { runTranscriptSuite };
