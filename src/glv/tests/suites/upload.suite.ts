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
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  waitForFile,
  withPage,
} from "../harness.js";
import { stdinTranscriptPath } from "../mock-common.js";

const runUploadSuite = (fx: FlavorFixture): void => {
  const SESSION_NAME = "Upload Test Session";
  const PROMPT_TEXT = "Read the attached file and summarize it.";

  let env: IntegrationEnv;
  let workDir: string;
  let captureDir: string;
  let capturePath: string;
  let uploadFilePath: string;
  const uploadFilename = "project-notes.txt";
  const uploadContent = `These are important project notes for ${fx.name} to read.`;

  beforeAll(async () => {
    captureDir = mkdtempSync(join(tmpdir(), "glv-capture-"));
    capturePath = join(captureDir, "stdin.txt");

    env = await fx.startEnv("glv-upload-", {
      sessionName: SESSION_NAME,
      captureStdin: capturePath,
    });

    workDir = join(env.scratchDir, "project");
    mkdirSync(workDir, { recursive: true });
    uploadFilePath = join(env.scratchDir, uploadFilename);
    writeFileSync(uploadFilePath, uploadContent);

    fx.seedSessions(env, [
      {
        id: "seed-session",
        name: "Seed Project",
        workingDir: join(env.scratchDir, "other-project"),
      },
    ]);
  }, 180000);

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
    it(`starts a session, saves files to GLV private storage, and passes paths to ${fx.name}`, async () => {
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

        // The agent received the absolute file path in its stdin (the
        // prompt). Read the transcript, not the latest-stdin capture:
        // the always-on suggestion ask overwrites that once the reply
        // lands.
        const captured = await waitForFile(stdinTranscriptPath(capturePath));
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

  const PASTED_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

  // A plain object so it serialises across the Playwright boundary.
  type PastePayload =
    | { kind: "image"; b64: string; mime: string }
    | { kind: "text"; text: string };

  const PASTED_PNG: PastePayload = {
    kind: "image",
    b64: PASTED_PNG_B64,
    mime: "image/png",
  };

  const pasteIntoForm = async (
    page: Page,
    payload: PastePayload,
  ): Promise<void> => {
    await page.evaluate((p) => {
      const dt = new DataTransfer();
      if (p.kind === "image") {
        const bin = atob(p.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], "clipboard.png", { type: p.mime }));
      } else {
        dt.setData("text/plain", p.text);
      }
      const evt = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      document.querySelector("form.new-session-form")!.dispatchEvent(evt);
    }, payload);
  };

  const readInputFileNames = async (page: Page): Promise<string[]> =>
    page
      .locator('input[type="file"]')
      .evaluate((el: HTMLInputElement) =>
        Array.from(el.files ?? []).map((f) => f.name),
      );

  describe("file upload — paste images from clipboard", () => {
    it("attaches a pasted image as a chip with a thumbnail", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        await pasteIntoForm(page, PASTED_PNG);

        await expect(page.locator(".upload-chip")).toBeVisible();
        await expect(page.locator(".chip-name")).toContainText(
          "pasted-image-1.png",
        );
        // Images render an <img> thumbnail, not the generic file-icon span.
        await expect(page.locator(".upload-chip img.chip-thumb")).toBeVisible();

        // Synced into the hidden input for the htmx multipart submit.
        expect(await readInputFileNames(page)).toEqual(["pasted-image-1.png"]);
      });
    });

    it("increments the name for successive pastes", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        await pasteIntoForm(page, PASTED_PNG);
        await pasteIntoForm(page, PASTED_PNG);

        await expect(page.locator(".chip-name")).toContainText([
          "pasted-image-1.png",
          "pasted-image-2.png",
        ]);
      });
    });

    it("removes a pasted-image chip on ✕ and clears the input", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        await pasteIntoForm(page, PASTED_PNG);

        await expect(page.locator(".upload-chip")).toBeVisible();
        await page.locator(".chip-remove").click();
        await expect(page.locator(".upload-chip")).toHaveCount(0);

        expect(await readInputFileNames(page)).toEqual([]);
      });
    });

    it("lets plain-text paste through without creating a chip", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        await page.locator("textarea[name=prompt]").focus();
        await pasteIntoForm(page, { kind: "text", text: "just some text" });

        await expect(page.locator(".upload-chip")).toHaveCount(0);
      });
    });
  });
};

export { runUploadSuite };
