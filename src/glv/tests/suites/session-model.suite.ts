import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The right pane's Model meta chip.
const modelChip = (page: Page): Locator =>
  page
    .locator(".session-meta .meta-chip")
    .filter({ has: page.locator(".meta-label", { hasText: /^Model$/ }) });

// Each flavor surfaces the session's model from its own store (goose: the
// row's model_config_json, claude: the transcript's assistant turns), so the
// shared assertions run against whatever the flavor's seeding wrote.
const runSessionModelSuite = (fx: FlavorFixture, expected: string): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-session-model-");
    fx.seedSessions(env, [
      {
        id: "t-model",
        name: "With Model",
        workingDir: join(env.scratchDir, "modelled"),
        providerName: "zai",
        model: expected,
      },
      {
        id: "t-plain",
        name: "No Model",
        workingDir: join(env.scratchDir, "plain"),
      },
    ]);
    fx.seedMessages(env, "t-model", [
      {
        role: "assistant",
        content: [{ type: "text", text: "Reply from the model." }],
        model: expected,
      },
    ]);
    fx.seedMessages(env, "t-plain", [
      {
        role: "user",
        content: [{ type: "text", text: "No assistant turn yet" }],
      },
    ]);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const open = async (
    id: string,
    run: (page: Page) => Promise<void>,
  ): Promise<void> =>
    withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/${fx.viewId(id)}`);
      await run(page);
    });

  it("shows the model the session ran with in the right pane", async () => {
    await open("t-model", async (page) => {
      const chip = modelChip(page);
      await expect(chip).toBeVisible();
      await expect(chip.locator(".meta-value")).toHaveText(expected);
    });
  });

  it("omits the model chip when the store records no model", async () => {
    await open("t-plain", async (page) => {
      await expect(modelChip(page)).toHaveCount(0);
    });
  });
};

export { modelChip, runSessionModelSuite };
