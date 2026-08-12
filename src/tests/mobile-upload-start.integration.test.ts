import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type IntegrationEnv,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

// iOS Safari blocks app code from reassigning input.files — the DataTransfer
// constructor throws. Simulate that here so the upload path is exercised the
// way a real iPhone sees it: the native picker works, only the JS rebuild is
// blocked.
const SIMULATE_IOS_NO_DATATRANSFER = `
globalThis.DataTransfer = class {
  constructor() { throw new TypeError("DataTransfer is not supported on this iOS build"); }
};
`;

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

const PROMPT = "Summarize the attached notes.";
const FILENAME = "notes.txt";
const CONTENT = "important project notes for goose to read.";

let env: IntegrationEnv;
let workDir: string;
let uploadFilePath: string;
let capturePath: string;

beforeAll(async () => {
  capturePath = join(mkdtempSync(join(tmpdir(), "glv-cap-")), "stdin.txt");
  env = await startIntegrationEnv("glv-mobup-", {
    sessionName: "Mobile Upload Start",
    captureStdin: capturePath,
  });
  workDir = join(env.scratchDir, "project");
  mkdirSync(workDir, { recursive: true });
  uploadFilePath = join(env.scratchDir, FILENAME);
  writeFileSync(uploadFilePath, CONTENT);
}, 90000);

afterAll(async () => {
  await env?.cleanup();
});

describe("start session with upload under iOS-style DataTransfer limits", () => {
  it("passes the attached file through to goose", async () => {
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
