import { mkdirSync } from "node:fs";
import { platform } from "node:os";
import { join, sep } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// A directory the OS resolves but spells differently from the canonical form
// the agent persists as working_dir. Before intake canonicalization, the
// new-session discovery poll compared raw strings, found no new session row,
// and stopped the healthy run at its timeout — every start from a pasted
// Windows path (forward slashes) or a trailing separator died ~10s in and
// needed a manual follow-up prompt to resume.
const runDirSpellingSuite = (fx: FlavorFixture): void => {
  const PROMPT_TEXT = "start with a non-canonical working dir";

  const isWin = platform() === "win32";

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
  // Pre-fix this 502s on the new-session form after the poll timeout.
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
    it.runIf(isWin)(
      `starts a ${fx.name} session when the working dir uses forward slashes`,
      async () => {
        await startFromSpelling(workDir.replaceAll("\\", "/"));
      },
    );
  });
};

export { runDirSpellingSuite };
