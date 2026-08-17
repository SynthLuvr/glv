import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type IntegrationEnv,
  insertSessions,
  startIntegrationEnv,
  waitForJsonFile,
} from "./integration-harness";

// A synthetic CLAUDE_CODE_* var only the inherited environment can supply —
// proof the spawn extends that environment rather than replacing it.
const PROBE = "CLAUDE_CODE_GLV_ENV_PROBE";
const PROBE_VALUE = "inherited";

const isEnv = (value: unknown): value is Record<string, string> =>
  value !== null && typeof value === "object";

let env: IntegrationEnv;
let envDir: string;
let envPath: string;

beforeAll(async () => {
  envDir = mkdtempSync(join(tmpdir(), "glv-sandboxed-"));
  envPath = join(envDir, "env.json");
  // Poisoned before the server launches, which inherits this process's env:
  // if glv stopped setting the variable on the spawn, the mock would report
  // "0" rather than silently passing on an ambient value.
  process.env.CLAUDE_CODE_SANDBOXED = "0";
  process.env[PROBE] = PROBE_VALUE;
  env = await startIntegrationEnv("glv-sandboxed-", { captureEnv: envPath });

  // Seed an existing session so the follow-up test can exercise the resume
  // path; its working dir must exist for the spawn.
  mkdirSync(join(env.scratchDir, "followup"), { recursive: true });
  insertSessions(env.dbs.flavor.projectsDir, [
    {
      id: "followup-1",
      name: "Follow Up",
      workingDir: join(env.scratchDir, "followup"),
    },
  ]);
}, 120000);

afterAll(async () => {
  await env?.cleanup();
  rmSync(envDir, { recursive: true, force: true });
  delete process.env.CLAUDE_CODE_SANDBOXED;
  delete process.env[PROBE];
});

// claude gates a directory it has never seen behind an interactive trust
// dialog that a headless --print run can never answer, so every glv spawn
// marks itself sandboxed.
describe("sandboxed env — trust gate bypassed for unseen directories", () => {
  it("sets CLAUDE_CODE_SANDBOXED on a brand-new session in a fresh dir", async () => {
    const workDir = join(env.scratchDir, "never-seen-before");
    mkdirSync(workDir, { recursive: true });
    const res = await authedFetch(env, "/sessions", {
      method: "POST",
      body: new URLSearchParams({
        prompt: "inspect the project",
        working_dir: workDir,
      }),
    });
    expect(res.status).toBe(200);

    const claudeEnv = await waitForJsonFile(envPath, isEnv);
    expect(claudeEnv.CLAUDE_CODE_SANDBOXED).toBe("1");
    expect(claudeEnv[PROBE]).toBe(PROBE_VALUE);
  });

  it("sets CLAUDE_CODE_SANDBOXED on a follow-up (resume) run too", async () => {
    // Drop the file from the prior run so the wait below sees this one.
    rmSync(envPath, { force: true });
    const res = await authedFetch(env, "/sessions/followup-1/prompt", {
      method: "POST",
      body: new URLSearchParams({ prompt: "follow up now" }),
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);

    const claudeEnv = await waitForJsonFile(envPath, isEnv);
    expect(claudeEnv.CLAUDE_CODE_SANDBOXED).toBe("1");
  });
});
