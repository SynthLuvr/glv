import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "@playwright/test";
import which from "which";
import {
  seedClaudeSessions,
  startCombinedEnv,
} from "../src/glv/tests/combined-harness.js";
import type { IntegrationEnv } from "../src/glv/tests/harness.js";
import { serveNginx413 } from "../src/glv/tests/suites/upload-413.suite.js";
import { gooseFixture } from "../src/goose/tests/integration-harness.js";

// Local PR-screenshot capture: boots a real `glv serve` on the mock
// integration-test fixture (mock goose agent, seeded session), drives the UI
// with Playwright, and writes PNGs into pr-shots/ (gitignored — upload them
// to GitHub user-attachments, never commit them).
//
// Some hosts cannot rasterize headless pages: on WSL2 + Chrome 153 the
// headless compositor never produces a frame, so DevTools-driven capture —
// what Playwright uses — hangs forever (Chrome's own --screenshot mode
// escapes it only by driving BeginFrames itself). A headed launch under Xvfb
// rasterizes normally, so probe headless capture once up front and fall back
// to a script-managed Xvfb when the probe times out.

const OUT = "pr-shots";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const SESSION_ID = "shots-1";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// A throwaway page load plus screenshot answers the only question that
// matters: can this host turn a headless page into pixels via DevTools?
const headlessRasterWorks = async (): Promise<boolean> => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent("<!doctype html><p>raster probe</p>");
    await page.screenshot({ timeout: 8000 });
    return true;
  } catch {
    return false;
  } finally {
    if (browser !== undefined) await browser.close().catch(() => undefined);
  }
};

// Xvfb claims a display by creating /tmp/.X<n>-lock; the first number
// without one wins.
const findFreeDisplay = (): { display: string; lock: string } => {
  for (let n = 99; n <= 120; n += 1) {
    const lock = `/tmp/.X${n}-lock`;
    if (!existsSync(lock)) return { display: `:${n}`, lock };
  }
  throw new Error("no free X display number between :99 and :120");
};

const startHeadedDisplay = async (): Promise<{
  display: string;
  xvfb: ChildProcess;
}> => {
  if (which.sync("Xvfb", { nothrow: true }) === null)
    throw new Error(
      "headless rasterization is unavailable on this host and Xvfb is " +
        "not installed — install it (e.g. `sudo apt install xvfb`) and retry",
    );
  const { display, lock } = findFreeDisplay();
  const xvfb = spawn("Xvfb", [display, "-screen", "0", "1600x1000x24"], {
    stdio: "ignore",
  });
  for (let i = 0; i < 50 && !existsSync(lock); i += 1) await sleep(100);
  if (!existsSync(lock)) {
    xvfb.kill("SIGTERM");
    throw new Error(`Xvfb failed to start on ${display}`);
  }
  return { display, xvfb };
};

// The teardown kills the fallback Xvfb; in headless mode there is nothing
// extra to stop.
const launchBrowser = async (): Promise<{
  browser: Browser;
  teardown: () => void;
}> => {
  if (await headlessRasterWorks())
    return { browser: await chromium.launch(), teardown: () => undefined };
  console.log(
    "headless rasterization unavailable on this host — " +
      "falling back to a headed launch under Xvfb",
  );
  const { display, xvfb } = await startHeadedDisplay();
  const browser = await chromium.launch({
    headless: false,
    env: { ...process.env, DISPLAY: display },
  });
  return { browser, teardown: () => xvfb.kill("SIGTERM") };
};

const capture = async (
  page: Page,
  name: string,
  selector?: string,
): Promise<void> => {
  const path = join(OUT, name);
  if (selector === undefined) await page.screenshot({ path });
  else await page.locator(selector).screenshot({ path });
  console.log(`captured ${path}`);
};

// The mobile layout opens with the sidebar pane in front; switch to the
// detail pane before shooting it. The toggle only appears once the viewport
// is narrow, so wait briefly and skip when it never shows.
const showDetailPaneOnMobile = async (page: Page): Promise<void> => {
  const toggle = page.locator('.mobile-pane-btn[data-pane="detail"]');
  await toggle
    .waitFor({ state: "visible", timeout: 3000 })
    .catch(() => undefined);
  if (await toggle.isVisible()) await toggle.click();
};

// The fixture's own browser context is headless, which cannot rasterize on
// the fallback path — this script launches its own browser, so its context
// must carry the auth cookie itself.
const addSessionCookie = async (
  context: BrowserContext,
  env: IntegrationEnv,
): Promise<void> => {
  await context.addCookies([
    {
      name: env.cookieName,
      value: env.dbs.token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
};

const startSeededEnv = async (): Promise<IntegrationEnv> => {
  // sleepMs keeps a submitted follow-up "running" so the busy composer
  // (Queue/Stop) can be captured before the run completes.
  const env = await gooseFixture.startEnv("glv-shots-", { sleepMs: 20000 });
  const workingDir = join(env.scratchDir, "project");
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  gooseFixture.seedSessions(env, [
    { id: SESSION_ID, name: "Screenshot Session", workingDir },
  ]);
  gooseFixture.seedMessages(env, SESSION_ID, [
    {
      role: "user",
      content: [{ type: "text", text: "Draft a release note for v1.4" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Sure — here is a draft release note for v1.4, ready to paste.",
        },
      ],
    },
  ]);
  return env;
};

const captureProxy413 = async (
  page: Page,
  workingDir: string,
): Promise<void> => {
  await serveNginx413(page);
  await page
    .locator('textarea[name="prompt"]')
    .fill("Read the attached screenshot");
  await page.locator('input[name="working_dir"]').fill(workingDir);
  await page.locator("button.send-btn").click();
  await page.locator(".proxy-413-hint").waitFor();
  await capture(page, "proxy-413-desktop.png", "form.new-session-form");
  // Drop the interception so later captures hit the real server.
  await page.unroute("**/sessions");
};

const captureViews = async (
  browser: Browser,
  env: IntegrationEnv,
): Promise<void> => {
  const context = await browser.newContext({ viewport: DESKTOP });
  await addSessionCookie(context, env);
  const page = await context.newPage();

  await page.goto(env.baseUrl);
  await page.locator("form.new-session-form").waitFor();
  await capture(page, "new-session-desktop.png", "form.new-session-form");

  await captureProxy413(page, join(env.scratchDir, "project"));

  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await page.locator("form.new-session-form").waitFor();
  await capture(page, "new-session-mobile.png", "form.new-session-form");

  await page.setViewportSize(DESKTOP);
  await page.goto(`${env.baseUrl}/sessions/${gooseFixture.viewId(SESSION_ID)}`);
  await page.locator("form.prompt-bar").waitFor();
  await capture(page, "session-desktop.png");
  await capture(page, "prompt-bar-desktop.png", "form.prompt-bar");

  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await page.locator("form.prompt-bar").waitFor();
  await capture(page, "session-mobile.png");

  // Busy composer: with a run active the bar shows Queue/Stop, and on a
  // phone that row is where the textarea used to collapse to a sliver.
  // Captured last so the running session cannot leak into earlier shots.
  await page.setViewportSize(DESKTOP);
  await page.goto(`${env.baseUrl}/sessions/${gooseFixture.viewId(SESSION_ID)}`);
  await page.locator("form.prompt-bar").waitFor();
  await page
    .locator('form.prompt-bar textarea[name="prompt"]')
    .fill("Queue the changelog pass while this run finishes");
  await page.locator("form.prompt-bar button.send-btn").click();
  await page
    .locator("form.prompt-bar button.stop-btn")
    .waitFor({ timeout: 20000 });
  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await capture(page, "prompt-bar-mobile-busy.png", "form.prompt-bar");

  await context.close();
};

// The merged product: one serve, both agents, the combined model picker.
const captureCombined = async (browser: Browser): Promise<void> => {
  const env = await startCombinedEnv("glv-shots-combined-");
  try {
    const workingDir = join(env.scratchDir, "project");
    mkdirSync(workingDir, { recursive: true });
    gooseFixture.seedSessions(env, [
      { id: SESSION_ID, name: "Screenshot Session", workingDir },
    ]);
    seedClaudeSessions(env, [
      { id: "shots-claude", name: "Claude Session", workingDir },
    ]);
    const context = await browser.newContext({ viewport: DESKTOP });
    await addSessionCookie(context, env);
    const page = await context.newPage();
    await page.goto(env.baseUrl);
    await page.locator("form.new-session-form").waitFor();
    await capture(
      page,
      "combined-new-session-desktop.png",
      "form.new-session-form",
    );
    await capture(page, "combined-desktop.png");
    await context.close();
  } finally {
    await env.cleanup();
  }
};

const env = await startSeededEnv();
const { browser, teardown } = await launchBrowser();
try {
  await captureViews(browser, env);
  await captureCombined(browser);
} finally {
  await browser.close();
  teardown();
  await env.cleanup();
}

console.log(
  `done — ${OUT}/*.png ready; upload to GitHub user-attachments and ` +
    "embed in the PR description (never commit image assets)",
);
