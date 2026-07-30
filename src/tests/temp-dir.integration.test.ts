import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type IntegrationEnv,
  insertSessions,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

const SESSION_NAME = "Temp Dir Session";
const PROMPT_TEXT = "Work in a temporary directory and report back.";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForFile = async (path: string, timeoutMs = 8000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf-8");
    await sleep(50);
  }
  throw new Error(`file ${path} not written within ${timeoutMs}ms`);
};

const tempSubDirs = (base: string) =>
  readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());

let env: IntegrationEnv;
let cwdCaptureDir: string;
let cwdCapturePath: string;

beforeAll(async () => {
  cwdCaptureDir = mkdtempSync(join(tmpdir(), "glv-cwd-"));
  cwdCapturePath = join(cwdCaptureDir, "cwd.txt");

  env = await startIntegrationEnv("glv-tempdir-", {
    sessionName: SESSION_NAME,
    captureCwd: cwdCapturePath,
  });

  // Seed a pre-existing session so the sidebar's #session-list exists for the
  // out-of-band swap, without colliding with new-session detection.
  insertSessions(env.dbs.sessionsDb, [
    {
      id: "seed-session",
      name: "Seed Project",
      workingDir: join(env.scratchDir, "other-project"),
    },
  ]);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
  rmSync(cwdCaptureDir, { recursive: true, force: true });
});

describe("temporary directory — form toggle", () => {
  it("renders the working-location toggle on the New Session form", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();
      await expect(page.locator(".source-toggle")).toBeVisible();
      await expect(
        page.locator('[data-source-radio="working_dir"]'),
      ).toBeChecked();
      await expect(
        page.locator('[data-source-radio="temp"]'),
      ).not.toBeChecked();
    });
  });

  it("switches between working directory and temporary directory bodies", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();

      // Working directory is the default — its body is visible.
      await expect(
        page.locator('[data-source-body="working_dir"]'),
      ).toBeVisible();
      await expect(page.locator('input[name="working_dir"]')).toBeVisible();
      await expect(page.locator('[data-source-body="temp"]')).toBeHidden();

      // Switch to temporary directory.
      await page.locator('[data-source-radio="temp"]').check();
      await expect(page.locator('[data-source-body="temp"]')).toBeVisible();
      await expect(page.locator(".temp-dir-hint")).toBeVisible();
      await expect(
        page.locator('[data-source-body="working_dir"]'),
      ).toBeHidden();

      // Switch back to working directory.
      await page.locator('[data-source-radio="working_dir"]').check();
      await expect(
        page.locator('[data-source-body="working_dir"]'),
      ).toBeVisible();
      await expect(page.locator('[data-source-body="temp"]')).toBeHidden();
    });
  });
});

describe("temporary directory — session lifecycle", () => {
  it("starts a session in a fresh temporary directory", async () => {
    const beforeDirs = tempSubDirs(env.tempDir);

    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();

      await page.locator('[data-source-radio="temp"]').check();
      await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
      await page.locator("button.send-btn").click();

      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });

      await expect(page.locator("#detail-pane")).toContainText(PROMPT_TEXT);
      await expect(page.locator("#session-list")).toContainText(SESSION_NAME, {
        timeout: 5000,
      });
    });

    // A temp working dir was created under GLV's private storage.
    const activeDirs = tempSubDirs(env.tempDir);
    expect(activeDirs.length).toBe(beforeDirs.length + 1);

    const newDir = activeDirs.find(
      (d) => !beforeDirs.some((b) => b.name === d.name),
    );
    expect(newDir).toBeTruthy();
    const tempDirPath = join(env.tempDir, newDir!.name);

    // goose ran with the temp dir as its working directory (cwd).
    const capturedCwd = await waitForFile(cwdCapturePath);
    expect(capturedCwd.trim()).toBe(tempDirPath);
  });

  it("deletes the temporary directory when the session is archived", async () => {
    const beforeDirs = tempSubDirs(env.tempDir);

    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();

      await page.locator('[data-source-radio="temp"]').check();
      await page.locator('textarea[name="prompt"]').fill("Cleanup test run.");
      await page.locator("button.send-btn").click();

      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });

      // Confirm a new temp dir was created for this session.
      const activeDirs = tempSubDirs(env.tempDir);
      expect(activeDirs.length).toBeGreaterThan(beforeDirs.length);

      // Extract the session id and archive via direct HTTP so the cleanup
      // logic is exercised deterministically.
      const hxPost = await page
        .locator("button.archive-btn")
        .getAttribute("hx-post");
      const sessionId = hxPost?.match(/\/sessions\/([^/]+)\/archive/)?.[1];
      expect(sessionId).toBeTruthy();

      const archiveRes = await authedFetch(
        env,
        `/sessions/${sessionId}/archive`,
        { method: "POST" },
      );
      expect(archiveRes.status).toBe(200);

      // The temp working dir is swept up; only pre-existing dirs remain.
      const afterDirs = tempSubDirs(env.tempDir);
      expect(afterDirs.length).toBeLessThanOrEqual(beforeDirs.length);
    });
  });
});
