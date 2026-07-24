import { type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  insertSessions,
  mockGoose,
  type SessionSeed,
  setAuthCookies,
  startServer,
  stopProcess,
  waitForHttp,
  withPage,
} from "./integration-harness";

let scratchDir: string;
let restoreGoosePath: () => void;
let serve: ChildProcess;
let readServeStderr: (() => string) | undefined;
let browser: Browser;
let context: BrowserContext;
let baseUrl: string;
let dbs: Databases;

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "glv-sidebar-"));
  dbs = createDatabases(scratchDir);

  restoreGoosePath = await mockGoose();

  const port = await findFreePort();
  baseUrl = `http://localhost:${port}`;

  const server = startServer(dbs, port);
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

describe("sidebar — session list visibility", () => {
  it("shows an empty state when the database has no sessions", async () => {
    await withPage(context, async (page) => {
      await page.goto(baseUrl);

      // The empty-state message replaces the session list.
      await expect(page.locator(".sidebar .empty")).toBeVisible();
      await expect(page.locator(".empty")).toContainText("No sessions found");

      // No session-list container or items are rendered.
      await expect(page.locator("#session-list")).toHaveCount(0);
      await expect(page.locator(".session-item")).toHaveCount(0);

      // The header counter reflects the empty database.
      await expect(page.locator(".session-count")).toHaveText("0");
    });
  });

  it("shows sessions in the sidebar once they exist in the database", async () => {
    const seeds: SessionSeed[] = [
      {
        id: "sidebar-alpha",
        name: "Alpha Session",
        workingDir: join(scratchDir, "alpha"),
      },
      {
        id: "sidebar-beta",
        name: "Beta Session",
        workingDir: join(scratchDir, "beta"),
      },
    ];
    insertSessions(dbs.sessionsDb, seeds);

    await withPage(context, async (page) => {
      await page.goto(baseUrl);

      // The session-list container is now rendered.
      await expect(page.locator("#session-list")).toBeVisible();

      // The empty-state message is gone.
      await expect(page.locator(".sidebar .empty")).toHaveCount(0);

      // Each session appears as a sidebar item with its name.
      await expect(page.locator(".session-item")).toHaveCount(2);
      await expect(page.locator("#session-list")).toContainText(
        "Alpha Session",
      );
      await expect(page.locator("#session-list")).toContainText("Beta Session");

      // The header counter reflects the populated database.
      await expect(page.locator(".session-count")).toHaveText("2");
    });
  });
});
