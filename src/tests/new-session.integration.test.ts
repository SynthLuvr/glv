import { type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
} from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  createDatabases,
  type Databases,
  findFreePort,
  mockGoose,
  setAuthCookies,
  startServer,
  stopProcess,
  waitForHttp,
  withPage,
} from "./integration-harness";

const SESSION_NAME = "Integration Test Session";
const PROMPT_TEXT = "Build the project and report the result.";

let scratchDir: string;
let workDir: string;
let restoreGoosePath: () => void;
let serve: ChildProcess;
let readServeStderr: (() => string) | undefined;
let browser: Browser;
let context: BrowserContext;
let baseUrl: string;
let dbs: Databases;

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "glv-integration-"));
  workDir = join(scratchDir, "project");
  mkdirSync(workDir, { recursive: true });

  // The sidebar's #session-list container is only rendered for a non-empty
  // list; the empty state omits it, leaving the out-of-band swap with no
  // target. Seed a session in a different working dir so it never collides
  // with new-session detection.
  dbs = createDatabases(scratchDir, {
    seed: {
      id: "seed-session",
      name: "Seed Project",
      workingDir: join(scratchDir, "other-project"),
    },
  });

  restoreGoosePath = await mockGoose();

  const port = await findFreePort();
  baseUrl = `http://localhost:${port}`;

  const server = startServer(dbs, port, {
    GOOSE_SESSIONS_DB: dbs.sessionsDb,
    GOOSE_MOCK_SESSION_NAME: SESSION_NAME,
  });
  serve = server.proc;
  readServeStderr = server.readStderr;

  await waitForHttp(baseUrl);

  browser = await chromium.launch();
  context = await browser.newContext();
  await setAuthCookies(context, dbs.token);
}, 90000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  if (serve !== undefined) await stopProcess(serve);
  restoreGoosePath?.();
  if (readServeStderr !== undefined && readServeStderr().trim() !== "")
    console.error("glv serve stderr:\n" + readServeStderr());
  if (scratchDir !== undefined)
    rmSync(scratchDir, { recursive: true, force: true });
});

describe("new session — working directory flow", () => {
  it("loads the New Session page for an authenticated user", async () => {
    await withPage(context, async (page) => {
      await page.goto(baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();
      await expect(page.locator('textarea[name="prompt"]')).toBeVisible();
      await expect(page.locator("button.send-btn")).toHaveText("Start session");
    });
  });

  it("starts a goose session from the form", async () => {
    await withPage(context, async (page) => {
      await page.goto(baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();

      await page.locator('input[name="working_dir"]').fill(workDir);
      await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
      await page.locator("button.send-btn").click();

      // The transcript replaces the form once goose creates the session and
      // glv re-keys the run onto the real session id.
      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });

      await expect(page.locator("#detail-pane")).toContainText(PROMPT_TEXT);

      // The sidebar refreshes out-of-band, so the new session appears without
      // a full page reload.
      await expect(page.locator("#session-list")).toContainText(SESSION_NAME, {
        timeout: 5000,
      });

      await expect(page.locator(".status-hint.error")).toHaveCount(0);
    });
  });
});
