import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type IntegrationEnv,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

// Distinct chunk texts so each streamed log is identifiable in the transcript.
const LINE_TEXTS = [
  "Streaming chunk one",
  "Streaming chunk two",
  "Streaming chunk three",
];

const LINE_COUNT = LINE_TEXTS.length;

// NDJSON envelopes — the same shape goose writes to stdout and persists to the
// messages table — so the mock can stream them as a live preview and commit
// them as real rows.
const STREAM_LINES: string[] = LINE_TEXTS.map((text) =>
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text }],
  }),
);

let env: IntegrationEnv;
let workDir: string;

beforeAll(async () => {
  env = await startIntegrationEnv("glv-stream-live-", {
    sessionName: "Live Streaming Session",
    lines: STREAM_LINES,
    // Persist each log to the sessions DB as it is produced (a real goose
    // run writes its transcript incrementally), and pace the commits so a
    // viewer tail observes them streaming in one at a time rather than in a
    // single batch.
    writeDb: true,
    lineDelayMs: 700,
    // Hold off before the first commit so the run is visibly active (with an
    // empty transcript) before logs begin arriving.
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

      // The transcript replaces the form once goose creates the session and
      // glv re-keys the run onto the real session id.
      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });

      // The run is live.
      await expect(page.locator(".status-hint.running")).toBeVisible();

      // The first committed log arrives over the event stream…
      await page.waitForFunction(
        () => document.querySelectorAll("#messages .message").length >= 1,
        null,
        { timeout: 10000 },
      );

      // …while the session is still running, so the rest are still on the
      // way — proving the logs stream in progressively, not all at once.
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
