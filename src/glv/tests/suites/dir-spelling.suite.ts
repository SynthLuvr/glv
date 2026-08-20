import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  IS_WIN,
  withPage,
} from "../harness.js";

// The OS resolves a directory from many spellings — a trailing separator,
// forward slashes on Windows, the "~\dir" tilde form — but the agent
// persists working_dir in one canonical form, so intake must normalize the
// same way or the new-session discovery poll misses the row and the healthy
// run dies at its timeout. Rendering must shorten home-prefixed paths back
// to "~/..." using the same separator-agnostic rules.
const runDirSpellingSuite = (fx: FlavorFixture): void => {
  const PROMPT_TEXT = "start with a non-canonical working dir";

  let env: IntegrationEnv;
  let workDir: string;
  let home: string;

  beforeAll(async () => {
    // A throwaway HOME so "~..." spellings resolve against a directory the
    // test controls rather than the real user profile.
    home = mkdtempSync(join(tmpdir(), "glv-tilde-home-"));
    mkdirSync(join(home, "tilde-proj"), { recursive: true });
    env = await fx.startEnv(
      "glv-dirspelling-",
      {
        sessionName: "Dir Spelling Session",
      },
      home,
    );
    workDir = join(env.scratchDir, "project");
    mkdirSync(workDir, { recursive: true });
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
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

    // Windows users type the tilde with a backslash; intake must expand it
    // like "~/" or the dir resolves against the server cwd and is rejected.
    it(`starts a ${fx.name} session when the working dir uses the ~ backslash form`, async () => {
      await startFromSpelling("~\\tilde-proj");
    });
  });

  describe("new session — home path shortening", () => {
    // A working dir stored with native Windows separators must still be
    // recognized as under ~ and shortened for display (the same rules the
    // form's default value relies on).
    it.runIf(IS_WIN)(
      `shortens a native-separator home working dir to ~ in the sidebar`,
      async () => {
        const nativeDir = `${home}\\native-dir`;
        fx.seedSessions(env, [
          {
            id: "native-dir-session",
            name: "Native Dir Session",
            workingDir: nativeDir,
          },
        ]);
        const res = await authedFetch(env, "/");
        const html = await res.text();
        expect(html).toMatch(/class="session-dir"[^>]*>~\/native-dir</);
      },
    );

    it.runIf(IS_WIN)(
      `prefills the new-session working dir input with the ~ form`,
      async () => {
        const nativeDir = `${home}\\native-dir`;
        const res = await authedFetch(
          env,
          `/sessions/new?working_dir=${encodeURIComponent(nativeDir)}`,
        );
        const html = await res.text();
        expect(html).toContain('value="~/native-dir"');
      },
    );
  });
};

export { runDirSpellingSuite };
