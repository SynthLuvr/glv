import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../system.js";
import {
  authedFetch,
  type IntegrationEnv,
  insertSessions,
  startIntegrationEnv,
} from "./integration-harness";

// A distinctive custom value so the override test can tell the real guardrails
// apart from whatever the operator passed on the command line.
const CUSTOM_SYSTEM = "CUSTOM SYSTEM MARKER — override the defaults.";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The mock writes the argv file shortly after the session row is detected, so
// retry until a complete, parseable array lands.
const waitForArgs = async (
  path: string,
  timeoutMs = 8000,
): Promise<string[]> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path))
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
        if (Array.isArray(parsed)) return parsed as string[];
      } catch {
        // Partial write; loop and retry.
      }
    await sleep(50);
  }
  throw new Error(`args file ${path} not written within ${timeoutMs}ms`);
};

// Returns the value immediately following `flag` in argv, or undefined.
const flagValue = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

let envDefault: IntegrationEnv;
let envCustom: IntegrationEnv;
let defaultArgsDir: string;
let defaultArgsPath: string;
let customArgsDir: string;
let customArgsPath: string;

beforeAll(async () => {
  defaultArgsDir = mkdtempSync(join(tmpdir(), "glv-sys-default-"));
  defaultArgsPath = join(defaultArgsDir, "args.json");
  envDefault = await startIntegrationEnv("glv-sys-default-", {
    captureArgs: defaultArgsPath,
  });

  customArgsDir = mkdtempSync(join(tmpdir(), "glv-sys-custom-"));
  customArgsPath = join(customArgsDir, "args.json");
  envCustom = await startIntegrationEnv(
    "glv-sys-custom-",
    { captureArgs: customArgsPath },
    ["--system", CUSTOM_SYSTEM],
  );

  // Seed an existing session in the default env so the follow-up test can
  // exercise the resume path; its working dir must exist for the spawn.
  mkdirSync(join(envDefault.scratchDir, "followup"), { recursive: true });
  insertSessions(envDefault.dbs.sessionsDb, [
    {
      id: "followup-1",
      name: "Follow Up",
      workingDir: join(envDefault.scratchDir, "followup"),
    },
  ]);
}, 120000);

afterAll(async () => {
  await envDefault?.cleanup();
  await envCustom?.cleanup();
  rmSync(defaultArgsDir, { recursive: true, force: true });
  rmSync(customArgsDir, { recursive: true, force: true });
});

const startSession = (
  env: IntegrationEnv,
  workDir: string,
  prompt: string,
): Promise<Response> => {
  mkdirSync(workDir, { recursive: true });
  return authedFetch(env, "/sessions", {
    method: "POST",
    body: new URLSearchParams({ prompt, working_dir: workDir }),
  });
};

describe("--system flag — default guardrails", () => {
  it("passes the built-in guardrails to a brand-new goose session", async () => {
    const res = await startSession(
      envDefault,
      join(envDefault.scratchDir, "new"),
      "inspect the project",
    );
    expect(res.status).toBe(200);

    const args = await waitForArgs(defaultArgsPath);
    // A new session is a fresh `run` (no resume), yet still carries --system.
    expect(args).not.toContain("--session-id");
    expect(flagValue(args, "--system")).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("passes the guardrails to a follow-up (resume) run too", async () => {
    // Drop the file from the prior run so waitForArgs waits for this one.
    rmSync(defaultArgsPath, { force: true });

    const res = await authedFetch(envDefault, "/sessions/followup-1/prompt", {
      method: "POST",
      body: new URLSearchParams({ prompt: "follow up now" }),
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);

    const args = await waitForArgs(defaultArgsPath);
    // A follow-up resumes by session id and still carries the guardrails.
    expect(args).toContain("--session-id");
    expect(flagValue(args, "--system")).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

describe("--system flag — explicit override", () => {
  it("passes a custom --system value instead of the built-in guardrails", async () => {
    const res = await startSession(
      envCustom,
      join(envCustom.scratchDir, "new"),
      "override test",
    );
    expect(res.status).toBe(200);

    const args = await waitForArgs(customArgsPath);
    expect(flagValue(args, "--system")).toBe(CUSTOM_SYSTEM);
    expect(flagValue(args, "--system")).not.toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
