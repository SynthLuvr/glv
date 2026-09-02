import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  collectSse,
  hasStatusEvent,
  hasStatusWhere,
  type IntegrationEnv,
  postSessionPrompt,
  postStop,
  waitForArgs,
  withPage,
} from "../../glv/tests/harness.js";
import { insertSessions, startIntegrationEnv } from "./integration-harness.js";

// The goose flavor is queue-only: `goose run` has no streaming-input mode,
// so even a crafted steer-mode POST must fall back to queue semantics, and
// the busy prompt bar keeps offering only Queue + Stop.
describe("steering normalization (goose, queue-only)", () => {
  let capDir: string;
  let argsPath: string;
  let env: IntegrationEnv;

  beforeAll(async () => {
    capDir = mkdtempSync(join(tmpdir(), "glv-goose-steer-cap-"));
    argsPath = join(capDir, "args.json");
    // A long sleep keeps the first run busy so the follow-up cannot start
    // its own run and must queue behind it.
    env = await startIntegrationEnv("glv-goose-steer-", {
      sleepMs: 20000,
      captureArgs: argsPath,
    });
    const workDir = join(env.scratchDir, "work");
    mkdirSync(workDir, { recursive: true });
    insertSessions(env.dbs.flavor.sessionsDb, [
      { id: "gq-1", name: "Queue Only", workingDir: workDir },
    ]);
  }, 120000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(capDir, { recursive: true, force: true });
  });

  it("normalizes a steer-mode POST to queue semantics", async () => {
    await postSessionPrompt(env, "gq-1", "first slow prompt");
    await waitForArgs(argsPath);

    // mode=steer is unsupported on goose: the server falls back to the
    // flavor default and the prompt renders as a queued card.
    const res = await postSessionPrompt(
      env,
      "gq-1",
      "crafted steer submit",
      "steer",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("queued-prompt");
    expect(html).toContain("crafted steer submit");

    // The status feed confirms the run is not steerable.
    const events = await collectSse(
      env,
      "/sessions/gq-1/events",
      (evs) => hasStatusWhere(evs, (d) => d.pendingCount === 1),
      15000,
    );
    expect(hasStatusEvent(events, "running")).toBe(true);
    expect(hasStatusWhere(events, (d) => d.steerable === false)).toBe(true);

    await postStop(env, "gq-1");
  }, 30000);

  it("keeps the busy prompt bar queue-only (no Steer button)", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/gq-1`);
      await postSessionPrompt(env, "gq-1", "hold the bar busy");
      await expect(page.locator("form.prompt-bar .queue-btn")).toBeVisible();
      await expect(page.locator("form.prompt-bar .steer-btn")).toHaveCount(0);
      await expect(
        page.locator("form.prompt-bar textarea.prompt-input"),
      ).toHaveAttribute("placeholder", "Queue a follow-up prompt…");
      await page.locator("form.prompt-bar .stop-btn").click();
      await expect(page.locator("form.prompt-bar .send-btn")).toBeVisible();
    });
  }, 30000);
});
