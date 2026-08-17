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
  insertSessions(env.dbs.sessionsDb, [
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

describe("system prompt — guardrails passed to every goose run", () => {
  it("passes the built-in guardrails to a brand-new goose session", async () => {
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
    expect(args).not.toContain("--session-id");
    expect(flagValue(args, "--system")).toBe(DEFAULT_SYSTEM_PROMPT);
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
    expect(args).toContain("--session-id");
    expect(flagValue(args, "--system")).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
