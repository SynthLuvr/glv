import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
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

const SESSION_NAME = "Upload Test Session";
const PROMPT_TEXT = "Read the attached file and summarize it.";

let env: IntegrationEnv;
let workDir: string;
let captureDir: string;
let capturePath: string;
let uploadFilePath: string;
const uploadFilename = "project-notes.txt";
const uploadContent = "These are important project notes for goose to read.";

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

beforeAll(async () => {
  captureDir = mkdtempSync(join(tmpdir(), "glv-capture-"));
  capturePath = join(captureDir, "stdin.txt");

  env = await startIntegrationEnv("glv-upload-", {
    sessionName: SESSION_NAME,
    captureStdin: capturePath,
  });

  workDir = join(env.scratchDir, "project");
  mkdirSync(workDir, { recursive: true });
  uploadFilePath = join(env.scratchDir, uploadFilename);
  writeFileSync(uploadFilePath, uploadContent);

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
  rmSync(captureDir, { recursive: true, force: true });
});

describe("file upload — paperclip and chips", () => {
  it("renders the paperclip button on the New Session form", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();
      await expect(page.locator(".paperclip-btn")).toBeVisible();
      await expect(page.locator('input[type="file"]')).toHaveCount(1);
    });
  });

  it("shows a chip when a file is selected and removes it on ✕", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();

      // Select a file — the hidden input fires a change event that the
      // uploads script listens for, creating a chip.
      await page.locator('input[type="file"]').setInputFiles(uploadFilePath);

      await expect(page.locator(".upload-chip")).toBeVisible();
      await expect(page.locator(".chip-name")).toContainText(uploadFilename);
      await expect(page.locator(".chip-size")).toBeVisible();

      // Remove it — the chip should vanish instantly (client-side, no
      // server round-trip).
      await page.locator(".chip-remove").click();
      await expect(page.locator(".upload-chip")).toHaveCount(0);
    });
  });
});

describe("file upload — session with attachments", () => {
  it("starts a session, saves files to GLV private storage, and passes paths to goose", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();

      await page.locator('input[type="file"]').setInputFiles(uploadFilePath);
      await expect(page.locator(".upload-chip")).toBeVisible();

      await page.locator('input[name="working_dir"]').fill(workDir);
      await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
      await page.locator("button.send-btn").click();

      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });

      // The original prompt text (without appended file paths) is shown.
      await expect(page.locator("#detail-pane")).toContainText(PROMPT_TEXT);

      // Files live in GLV's private uploads area, never in the working dir.
      expect(existsSync(join(workDir, uploadFilename))).toBe(false);

      const sessionDirs = readdirSync(env.uploadsDir, {
        withFileTypes: true,
      }).filter((d) => d.isDirectory());
      expect(sessionDirs.length).toBe(1);

      const savedPath = join(
        env.uploadsDir,
        sessionDirs[0].name,
        uploadFilename,
      );
      expect(existsSync(savedPath)).toBe(true);
      expect(readFileSync(savedPath, "utf-8")).toBe(uploadContent);

      // goose received the absolute file path in its stdin (the prompt).
      const captured = await waitForFile(capturePath);
      expect(captured).toContain(PROMPT_TEXT);
      expect(captured).toContain(savedPath);
      expect(captured).toContain("Attached files");
    });
  });

  it("deletes uploads when the session is archived", async () => {
    await withPage(env.context, async (page) => {
      // Record pre-existing dirs so leftover uploads from earlier tests
      // don't make the post-archive count assertion fail.
      const beforeDirs = readdirSync(env.uploadsDir, {
        withFileTypes: true,
      }).filter((d) => d.isDirectory());

      await page.goto(env.baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();

      await page.locator('input[type="file"]').setInputFiles(uploadFilePath);
      await expect(page.locator(".upload-chip")).toBeVisible();
      await page.locator('input[name="working_dir"]').fill(workDir);
      await page.locator('textarea[name="prompt"]').fill("Cleanup test run.");
      await page.locator("button.send-btn").click();

      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });

      // Confirm a new upload dir was created by this session.
      const activeDirs = readdirSync(env.uploadsDir, {
        withFileTypes: true,
      }).filter((d) => d.isDirectory());
      expect(activeDirs.length).toBeGreaterThan(beforeDirs.length);

      // Extract the session id from the archive button's hx-post attribute
      // and archive via direct HTTP so the cleanup logic is exercised
      // deterministically.
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

      // The session's upload dir should be gone; only pre-existing dirs remain.
      const afterDirs = readdirSync(env.uploadsDir, {
        withFileTypes: true,
      }).filter((d) => d.isDirectory());
      expect(afterDirs.length).toBeLessThanOrEqual(beforeDirs.length);
    });
  });
});
