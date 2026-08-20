import { mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  IS_WIN,
  withPage,
} from "../harness.js";

// The OS resolves a directory from many spellings — a trailing separator,
// forward slashes on Windows — but the agent persists working_dir in one
// canonical form, so intake must normalize the same way or the new-session
// discovery poll misses the row and the healthy run dies at its timeout.
const runDirSpellingSuite = (fx: FlavorFixture): void => {
  const PROMPT_TEXT = "start with a non-canonical working dir";

  let env: IntegrationEnv;
  let workDir: string;

  beforeAll(async () => {
    env = await fx.startEnv("glv-dirspelling-", {
      sessionName: "Dir Spelling Session",
    });
    workDir = join(env.scratchDir, "project");
    mkdirSync(workDir, { recursive: true });
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  // Submitting the form with a variant spelling must still establish the
  // session: the transcript replaces the form and no error hint appears.
  const startFromSpelling = async (spelling: string): Promise<void> => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await page.locator('input[name="working_dir"]').fill(spelling);
      await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
      await page.locator("button.send-btn").click();
      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });
      await expect(page.locator(".status-hint.error")).toHaveCount(0);
    });
  };

  describe("new session — working directory spelling", () => {
    it(`starts a ${fx.name} session when the working dir ends with a separator`, async () => {
      await startFromSpelling(workDir + sep);
    });

    // On Windows a forward-slash spelling exists and is what users paste;
    // on POSIX it names a different directory and cannot be used.
    it.runIf(IS_WIN)(
      `starts a ${fx.name} session when the working dir uses forward slashes`,
      async () => {
        await startFromSpelling(workDir.replaceAll("\\", "/"));
      },
    );
  });
};

export { runDirSpellingSuite };
