import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { it } from "vitest";
import {
  fakeHomeEnv,
  waitForServeExit,
  writeCronConfig,
} from "../../glv/tests/harness.js";
import { claudeFixture } from "./integration-harness";

// claude has no model surface, so a scheduled-run model pin cannot be
// honored: serve must refuse to start, naming the job, instead of
// silently firing it on the default model.

it("refuses to serve a cron job with a model pin", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "glv-claude-pin-"));
  const cfgPath = writeCronConfig(homeDir, claudeFixture.binName, [
    {
      name: "pinned",
      schedule: "* * * * * *",
      prompt: "Pinned nowhere",
      workingDir: tmpdir(),
      modelProvider: "zai",
      model: "glm-5.3",
    },
  ]);

  // serve resolves the agent binary against PATH, which CI runners lack;
  // the mock is never invoked — validation exits serve first. The 90s
  // exit deadline rides out runner contention that has pushed cold serve
  // boots past the 20s default; vitest's 120s ceiling still bounds the
  // test, so no explicit per-test timeout is needed.
  const restoreAgent = await claudeFixture.mockAgent();
  try {
    const { status, stderr } = await waitForServeExit(
      claudeFixture.binPath,
      ["serve", ...claudeFixture.defaultServeArgs(homeDir)],
      { ...fakeHomeEnv(homeDir), GLV_CONFIG: cfgPath },
      90_000,
    );
    if (status === null)
      throw new Error("serve neither refused nor started within 90s");
    expect(status).not.toBe(0);
    expect(stderr).toContain("pinned");
    expect(stderr).toContain("does not support model selection");
  } finally {
    restoreAgent();
    rmSync(homeDir, { recursive: true, force: true });
  }
});
