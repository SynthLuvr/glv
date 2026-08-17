import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../../system.js";
import {
  type FlavorFixture,
  type IntegrationEnv,
  postFollowUp,
  postNewSession,
  waitForJsonFile,
} from "../harness.js";

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

const runSystemFlagSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let argsDir: string;
  let argsPath: string;

  beforeAll(async () => {
    argsDir = mkdtempSync(join(tmpdir(), "glv-sys-"));
    argsPath = join(argsDir, "args.json");
    env = await fx.startEnv("glv-sys-", { captureArgs: argsPath });

    // Seed an existing session so the follow-up test can exercise the resume
    // path; its working dir must exist for the spawn.
    mkdirSync(join(env.scratchDir, "followup"), { recursive: true });
    fx.seedSessions(env, [
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

  describe(`system prompt — guardrails passed to every ${fx.name} run`, () => {
    it(`passes the built-in guardrails to a brand-new ${fx.name} session`, async () => {
      const workDir = join(env.scratchDir, "new");
      mkdirSync(workDir, { recursive: true });
      const res = await postNewSession(env, workDir, "inspect the project");
      expect(res.status).toBe(200);

      const args = await waitForArgs(argsPath);
      expect(args).not.toContain(fx.resumeFlag);
      fx.assertNewRunArgs?.(args);
      expect(flagValue(args, fx.systemFlag)).toBe(DEFAULT_SYSTEM_PROMPT);
    });

    it("passes the guardrails to a follow-up (resume) run too", async () => {
      // Drop the file from the prior run so waitForArgs waits for this one.
      rmSync(argsPath, { force: true });
      const res = await postFollowUp(env, "followup-1", "follow up now");
      expect(res.status).toBe(200);

      const args = await waitForArgs(argsPath);
      expect(args).toContain(fx.resumeFlag);
      fx.assertResumeRunArgs?.(args);
      expect(flagValue(args, fx.systemFlag)).toBe(DEFAULT_SYSTEM_PROMPT);
    });
  });
};

export { runSystemFlagSuite };
