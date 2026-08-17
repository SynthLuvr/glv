import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type IntegrationEnv,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

const LINE_TEXTS = [
  "Streaming chunk one",
  "Streaming chunk two",
  "Streaming chunk three",
];

const LINE_COUNT = LINE_TEXTS.length;

// NDJSON events matching claude's stream-json stdout shape, so the mock can
// both stream them as a preview and commit them as transcript lines.
const STREAM_LINES = LINE_TEXTS.map((text) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  }),
);

let env: IntegrationEnv;
let workDir: string;

beforeAll(async () => {
  env = await startIntegrationEnv("glv-stream-live-", {
    sessionName: "Live Streaming Session",
    lines: STREAM_LINES,
    // Write each line to the sessions DB as it streams, paced so the viewer
    // sees them arrive one at a time rather than all at once.
    writeDb: true,
    lineDelayMs: 700,
    // Keep the run active (transcript empty) before the first line arrives.
    sleepMs: 700,
  });
  workDir = join(env.scratchDir, "project");
  mkdirSync(workDir, { recursive: true });
}, 120000);

afterAll(async () => {
  await env?.cleanup();
});

describe("live log streaming", () => {
  it("streams committed logs into the transcript until the session ends", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await page.locator("form.new-session-form").waitFor();
      await page.locator('input[name="working_dir"]').fill(workDir);
      await page.locator('textarea[name="prompt"]').fill("stream a response");
      await page.locator("button.send-btn").click();

      // The transcript replaces the form once claude creates the session;
      // glv pre-assigned its id before the run started.
      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });

      await expect(page.locator(".status-hint.running")).toBeVisible();

      // The first log arrives while the run is still active, proving the
      // transcript fills progressively rather than in a single batch.
      await page.waitForFunction(
        () => document.querySelectorAll("#messages .message").length >= 1,
        null,
        { timeout: 10000 },
      );
      const partial = await page.locator("#messages .message").count();
      expect(partial).toBeLessThan(LINE_COUNT);

      // Every committed log eventually lands in the transcript, in order.
      await expect(page.locator("#messages .message")).toHaveCount(LINE_COUNT, {
        timeout: 10000,
      });
      await expect(page.locator("#messages")).toContainText(LINE_TEXTS[0]);
      await expect(page.locator("#messages")).toContainText(
        LINE_TEXTS[LINE_COUNT - 1],
      );

      // The run finishes and the prompt bar returns to its idle (Send) state.
      await expect(page.locator("[data-prompt-bar] .send-btn")).toBeVisible({
        timeout: 10000,
      });
      await expect(page.locator(".status-hint.running")).toHaveCount(0);
    });
  });
}, 60000);
