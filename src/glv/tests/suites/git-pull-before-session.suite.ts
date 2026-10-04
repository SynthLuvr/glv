import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runGitPullBeforeSessionSuite = (fx: FlavorFixture): void => {
  const PROMPT_TEXT = "git pull integration test";
  const MARKER_FILE = "pulled-by-glv.txt";

  // GIT_TERMINAL_PROMPT=0 turns credential prompts into hard failures
  // instead of hanging.
  const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.email=test@glv.local",
        "-c",
        "user.name=GLV Test",
        ...args,
      ],
      { stdio: ["ignore", "ignore", "ignore"], env: GIT_ENV },
    );
  };

  let env: IntegrationEnv;

  // A clone left one commit behind its (local) remote, so a `git pull` is a
  // clean fast-forward that brings in MARKER_FILE.
  let behindCloneDir: string;

  // A real repo with no upstream configured, so `git pull` fails — exercising
  // the swallow-and-warn path.
  let noUpstreamDir: string;

  beforeAll(async () => {
    env = await fx.startEnv("glv-gitpull-", {
      sessionName: "Git Pull Test",
    });

    const root = join(env.scratchDir, "git");
    const sourceDir = join(root, "source");
    behindCloneDir = join(root, "clone");
    mkdirSync(sourceDir, { recursive: true });

    git(sourceDir, "init", "-b", "main");
    writeFileSync(join(sourceDir, "base.txt"), "base");
    git(sourceDir, "add", "-A");
    git(sourceDir, "commit", "-q", "-m", "base");

    // Clone before the marker commit exists, so the clone starts behind.
    git(root, "clone", "-q", sourceDir, behindCloneDir);

    // Now advance the source past the clone with a marker file.
    writeFileSync(join(sourceDir, MARKER_FILE), "pulled");
    git(sourceDir, "add", "-A");
    git(sourceDir, "commit", "-q", "-m", "add marker");

    const root2 = join(env.scratchDir, "git-noupstream");
    noUpstreamDir = join(root2, "repo");
    mkdirSync(noUpstreamDir, { recursive: true });
    git(noUpstreamDir, "init", "-b", "main");
    writeFileSync(join(noUpstreamDir, "a.txt"), "a");
    git(noUpstreamDir, "add", "-A");
    git(noUpstreamDir, "commit", "-q", "-m", "init");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const startSessionIn = async (workingDir: string): Promise<void> => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await page.locator('input[name="working_dir"]').fill(workingDir);
      await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
      await page.locator("button.send-btn").click();
      // The archive button appears once the session is live.
      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });
    });
  };

  describe("git pull before a new session", () => {
    it(`pulls the latest commits into the working directory before ${fx.name} starts`, async () => {
      expect(existsSync(join(behindCloneDir, MARKER_FILE))).toBe(false);

      await startSessionIn(behindCloneDir);

      expect(existsSync(join(behindCloneDir, MARKER_FILE))).toBe(true);
    });

    it("starts a session even when git pull fails, logging a warning", async () => {
      await startSessionIn(noUpstreamDir);

      // The pull failure was swallowed but surfaced via console.warn on stderr.
      expect(env.serverStderr()).toContain("git pull failed");
    });
  });
};

export { runGitPullBeforeSessionSuite };
