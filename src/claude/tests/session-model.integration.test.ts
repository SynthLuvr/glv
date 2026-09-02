import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type IntegrationEnv, withPage } from "../../glv/tests/harness.js";
import {
  modelChip,
  runSessionModelSuite,
} from "../../glv/tests/suites/session-model.suite.js";
import { claudeFixture } from "./integration-harness.js";

// claude records the model on the transcript's assistant turns.
describe("session model chip", () =>
  runSessionModelSuite(claudeFixture, "claude-sonnet-4-5"));

// claude-specific: locally generated assistant lines (API-error notices)
// carry a bracketed "<synthetic>" placeholder rather than a model id, and
// the parser takes the last model seen — the chip must keep naming the
// model that produced the real turns.
describe("synthetic assistant turns", () => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await claudeFixture.startEnv("glv-synthetic-model-");
    claudeFixture.seedSessions(env, [
      {
        id: "t-synthetic",
        name: "Synthetic Tail",
        workingDir: join(env.scratchDir, "synthetic"),
      },
    ]);
    claudeFixture.seedMessages(env, "t-synthetic", [
      {
        role: "assistant",
        content: [{ type: "text", text: "Real reply." }],
        model: "claude-sonnet-4-5",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "API Error: rate limited." }],
        model: "<synthetic>",
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("keeps the real model when the transcript ends with a synthetic turn", async () => {
    await withPage(env.context, async (page: Page) => {
      await page.goto(`${env.baseUrl}/sessions/t-synthetic`);
      await expect(modelChip(page).locator(".meta-value")).toHaveText(
        "claude-sonnet-4-5",
      );
    });
  });
});
