import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../../glv/system.js";
import {
  authedFetch,
  type IntegrationEnv,
  insertSessions,
  startIntegrationEnv,
  waitForJsonFile,
} from "./integration-harness";

const isArgv = (value: unknown): value is string[] => Array.isArray(value);

const waitForArgs = (path: string): Promise<string[]> =>
  waitForJsonFile(path, isArgv);

const flagValue = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

let env: IntegrationEnv;
let argsDir: string;
let argsPath: string;

beforeAll(async () => {
  argsDir = mkdtempSync(join(tmpdir(), "glv-sys-"));
  argsPath = join(argsDir, "args.json");
  env = await startIntegrationEnv("glv-sys-", { captureArgs: argsPath });

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
  rmSync(argsDir, { recursive: true, force: true });
});

describe("system prompt — guardrails passed to every claude run", () => {
  it("passes the built-in guardrails to a brand-new claude session", async () => {
    const workDir = join(env.scratchDir, "new");
    mkdirSync(workDir, { recursive: true });
    const res = await authedFetch(env, "/sessions", {
      method: "POST",
      body: new URLSearchParams({
        prompt: "inspect the project",
        working_dir: workDir,
      }),
    });
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(args).not.toContain("--resume");
    // The session id is pre-assigned, not discovered after the fact.
    expect(flagValue(args, "--session-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(flagValue(args, "--append-system-prompt")).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
    // Default "inherit": no flag, so claude honours settings.json.
    expect(args).not.toContain("--permission-mode");
  });

  it("passes the guardrails to a follow-up (resume) run too", async () => {
    // Drop the file from the prior run so waitForArgs waits for this one.
    rmSync(argsPath, { force: true });
    const res = await authedFetch(env, "/sessions/followup-1/prompt", {
      method: "POST",
      body: new URLSearchParams({ prompt: "follow up now" }),
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);

    const args = await waitForArgs(argsPath);
    expect(args).toContain("--resume");
    expect(flagValue(args, "--append-system-prompt")).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
    expect(args).not.toContain("--permission-mode");
  });
});
