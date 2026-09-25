import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  authedFetch,
  cronJobRow,
  flagValue,
  type IntegrationEnv,
  waitForArgs,
} from "../../glv/tests/harness.js";
import { claudeFixture } from "./integration-harness";

// claude carries model pins like goose: a scheduled run pinned to a
// claude model saves (agent + pin on the row), fires passing --model
// <alias>, and a pin claude does not offer rejects at save time instead
// of storing a broken job.

let env: IntegrationEnv;
let argsDir: string;
let argsPath: string;
let workDir: string;

beforeAll(async () => {
  argsDir = mkdtempSync(join(tmpdir(), "glv-claude-pin-args-"));
  argsPath = join(argsDir, "args.json");
  workDir = mkdtempSync(join(tmpdir(), "glv-claude-pin-work-"));
  env = await claudeFixture.startEnv("glv-claude-pin-", {
    captureArgs: argsPath,
  });
}, 180000);

afterAll(async () => {
  await env?.cleanup();
  rmSync(argsDir, { recursive: true, force: true });
});

it("saves a claude-pinned job and fires it with --model", async () => {
  const res = await authedFetch(env, "/cron", {
    method: "POST",
    body: new URLSearchParams({
      job_name: "pinned claude sweep",
      schedule: "* * * * * *",
      prompt: "Pinned claude sweep",
      working_dir: workDir,
      model: "claude:claude:sonnet",
    }),
  });
  expect(res.status).toBe(200);
  expect(cronJobRow(env.dbs.cronDb, "pinned claude sweep")).toMatchObject({
    agent: "claude",
    modelProvider: "claude",
    model: "sonnet",
  });

  const args = await waitForArgs(argsPath);
  expect(flagValue(args, "--model")).toBe("sonnet");
}, 60000);

it("rejects a pin claude does not offer", async () => {
  const res = await authedFetch(env, "/cron", {
    method: "POST",
    body: new URLSearchParams({
      job_name: "bad claude pin",
      schedule: "* * * * * *",
      prompt: "Bad pin",
      working_dir: workDir,
      model: "claude:claude:not-a-model",
    }),
  });
  expect(res.status).toBe(422);
  expect(await res.text()).toContain("no longer available in claude");
  expect(cronJobRow(env.dbs.cronDb, "bad claude pin")).toBeUndefined();
});
