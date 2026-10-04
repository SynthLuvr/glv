import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  waitForFile,
  withPage,
} from "../harness.js";

const runMobileUploadStartSuite = (fx: FlavorFixture): void => {
  // iOS Safari blocks app code from reassigning input.files — the DataTransfer
  // constructor throws. Simulate that here so the upload path is exercised the
  // way a real iPhone sees it: the native picker works, only the JS rebuild is
  // blocked.
  const SIMULATE_IOS_NO_DATATRANSFER = `
globalThis.DataTransfer = class {
  constructor() { throw new TypeError("DataTransfer is not supported on this iOS build"); }
};
`;

  const PROMPT = "Summarize the attached notes.";
  const FILENAME = "notes.txt";
  const CONTENT = `important project notes for ${fx.name} to read.`;

  let env: IntegrationEnv;
  let workDir: string;
  let uploadFilePath: string;
  let capturePath: string;

  beforeAll(async () => {
    capturePath = join(mkdtempSync(join(tmpdir(), "glv-cap-")), "stdin.txt");
    env = await fx.startEnv("glv-mobup-", {
      sessionName: "Mobile Upload Start",
      captureStdin: capturePath,
    });
    workDir = join(env.scratchDir, "project");
    mkdirSync(workDir, { recursive: true });
    uploadFilePath = join(env.scratchDir, FILENAME);
    writeFileSync(uploadFilePath, CONTENT);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("start session with upload under iOS-style DataTransfer limits", () => {
    it(`passes the attached file through to ${fx.name}`, async () => {
      await withPage(env.context, async (page) => {
        await page.addInitScript(SIMULATE_IOS_NO_DATATRANSFER);
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 5000 }),
          page.locator("form.new-session-form .paperclip-btn").click(),
        ]);
        await chooser.setFiles(uploadFilePath);
        await expect(page.locator(".upload-chip")).toBeVisible();

        await page.locator('input[name="working_dir"]').fill(workDir);
        await page.locator("textarea.prompt-input").fill(PROMPT);
        await page.locator("button.send-btn").click();

        const captured = await waitForFile(capturePath);
        expect(captured).toContain(PROMPT);
        expect(captured).toContain("Attached files");
        expect(captured).toContain(FILENAME);
      });
    }, 60000);
  });
};

export { runMobileUploadStartSuite };
