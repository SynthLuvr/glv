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
  type IntegrationEnv,
  insertMessages,
  insertSessions,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

const SESSION_NAME = "Follow-up Upload Session";
const FOLLOWUP_PROMPT = "Summarise the attachment in this follow-up.";

let env: IntegrationEnv;
let workDir: string;
let captureDir: string;
let capturePath: string;
let uploadFilePath: string;
const uploadFilename = "followup-notes.txt";
const uploadContent = "Notes for the follow-up run.";

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
  captureDir = mkdtempSync(join(tmpdir(), "glv-followup-cap-"));
  capturePath = join(captureDir, "stdin.txt");

  env = await startIntegrationEnv("glv-followup-up-", {
    sessionName: SESSION_NAME,
    captureStdin: capturePath,
  });

  workDir = join(env.scratchDir, "project");
  mkdirSync(workDir, { recursive: true });
  uploadFilePath = join(env.scratchDir, uploadFilename);
  writeFileSync(uploadFilePath, uploadContent);

  insertSessions(env.dbs.projectsDir, [
    { id: "followup-1", name: "Follow-up Project", workingDir: workDir },
    // A dedicated session for the destructive archive-cleanup case so it
    // never archives the session the other tests navigate to.
    { id: "followup-2", name: "Follow-up Cleanup", workingDir: workDir },
  ]);
  insertMessages(env.dbs.projectsDir, "followup-1", [
    { role: "user", content: [{ type: "text", text: "initial prompt" }] },
    { role: "assistant", content: [{ type: "text", text: "initial reply" }] },
  ]);
  insertMessages(env.dbs.projectsDir, "followup-2", [
    { role: "user", content: [{ type: "text", text: "initial prompt" }] },
    { role: "assistant", content: [{ type: "text", text: "initial reply" }] },
  ]);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
  rmSync(captureDir, { recursive: true, force: true });
});

describe("follow-up upload — attach button and chips", () => {
  it("renders the attach button and file input on the prompt bar", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/followup-1`);
      await expect(page.locator("form.prompt-bar")).toBeVisible();
      await expect(
        page.locator("form.prompt-bar .paperclip-btn"),
      ).toBeVisible();
      await expect(
        page.locator("form.prompt-bar input[type=file]"),
      ).toHaveCount(1);
    });
  });

  it("shows a chip when a file is attached to a follow-up and removes it", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/followup-1`);

      await page
        .locator("form.prompt-bar input[type=file]")
        .setInputFiles(uploadFilePath);

      await expect(page.locator(".upload-chip")).toBeVisible();
      await expect(page.locator(".chip-name")).toContainText(uploadFilename);

      await page.locator(".chip-remove").click();
      await expect(page.locator(".upload-chip")).toHaveCount(0);
    });
  });
});

describe("follow-up upload — submitting with attachments", () => {
  it("saves files to private storage and passes their paths to claude", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/followup-1`);

      await page
        .locator("form.prompt-bar input[type=file]")
        .setInputFiles(uploadFilePath);
      await expect(page.locator(".upload-chip")).toBeVisible();

      await page
        .locator('form.prompt-bar textarea[name="prompt"]')
        .fill(FOLLOWUP_PROMPT);
      await page.locator("form.prompt-bar button.send-btn").click();

      // claude (resume invocation) received the prompt with the appended file
      // paths in its stdin.
      const captured = await waitForFile(capturePath);
      expect(captured).toContain(FOLLOWUP_PROMPT);
      expect(captured).toContain("Attached files");

      // The file lives in GLV's private uploads area, never in the working dir.
      expect(existsSync(join(workDir, uploadFilename))).toBe(false);

      const sessionDirs = readdirSync(env.uploadsDir, {
        withFileTypes: true,
      }).filter((d) => d.isDirectory());
      expect(sessionDirs.length).toBeGreaterThanOrEqual(1);

      let savedPath = "";
      for (const dir of sessionDirs) {
        const candidate = join(env.uploadsDir, dir.name, uploadFilename);
        if (existsSync(candidate)) {
          savedPath = candidate;
          break;
        }
      }
      expect(savedPath).not.toBe("");
      expect(readFileSync(savedPath, "utf-8")).toBe(uploadContent);
      expect(captured).toContain(savedPath);
    });
  });

  it("deletes follow-up uploads when the session is archived", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/followup-2`);

      const beforeDirs = readdirSync(env.uploadsDir, {
        withFileTypes: true,
      }).filter((d) => d.isDirectory());

      await page
        .locator("form.prompt-bar input[type=file]")
        .setInputFiles(uploadFilePath);
      await page
        .locator('form.prompt-bar textarea[name="prompt"]')
        .fill("cleanup follow-up run.");
      await page.locator("form.prompt-bar button.send-btn").click();

      // The uploads are saved server-side before the response swaps the
      // transcript, so wait for the submitted follow-up to render before
      // counting the new upload dir.
      await expect(page.locator("#detail-pane")).toContainText(
        "cleanup follow-up run.",
        { timeout: 10000 },
      );

      const activeDirs = readdirSync(env.uploadsDir, {
        withFileTypes: true,
      }).filter((d) => d.isDirectory());
      expect(activeDirs.length).toBeGreaterThan(beforeDirs.length);

      // Archive via direct HTTP so the cleanup logic is exercised
      // deterministically.
      const archiveRes = await authedFetch(
        env,
        "/sessions/followup-2/archive",
        { method: "POST" },
      );
      expect(archiveRes.status).toBe(200);

      const afterDirs = readdirSync(env.uploadsDir, {
        withFileTypes: true,
      }).filter((d) => d.isDirectory());
      expect(afterDirs.length).toBeLessThanOrEqual(beforeDirs.length);
    });
  });
});

const PASTED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

type PastePayload =
  | { kind: "image"; b64: string; mime: string }
  | { kind: "text"; text: string };

const PASTED_PNG: PastePayload = {
  kind: "image",
  b64: PASTED_PNG_B64,
  mime: "image/png",
};

const pasteIntoPromptBar = async (
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
    document.querySelector("form.prompt-bar")!.dispatchEvent(evt);
  }, payload);
};

describe("follow-up upload — paste images into the prompt bar", () => {
  it("attaches a pasted image as a chip with a thumbnail", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/followup-1`);

      await pasteIntoPromptBar(page, PASTED_PNG);

      await expect(page.locator(".upload-chip")).toBeVisible();
      await expect(page.locator(".chip-name")).toContainText(
        "pasted-image-1.png",
      );
      await expect(page.locator(".upload-chip img.chip-thumb")).toBeVisible();
    });
  });

  it("lets plain-text paste through to the textarea without a chip", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/sessions/followup-1`);

      await page.locator('form.prompt-bar textarea[name="prompt"]').focus();
      await pasteIntoPromptBar(page, { kind: "text", text: "just some text" });

      await expect(page.locator(".upload-chip")).toHaveCount(0);
    });
  });
});
