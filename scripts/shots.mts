import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { gooseFixture } from "../src/goose/tests/integration-harness.js";

// Local PR-screenshot capture: boots a real `glv-goose serve` against the
// mock goose agent (exactly like the integration harness), seeds a session,
// drives the UI with Playwright, and writes PNGs into pr-shots/ (gitignored
// — never commit them; upload to GitHub user-attachments instead).
//
// Some hosts cannot rasterize headlessly: on WSL2 with Chrome 153 the
// headless compositor never produces a frame, so Page.captureScreenshot
// hangs forever (even fromSurface:false has nothing to read back), on both
// the full Chrome binary and the headless shell, with every GL flag tried.
// The CLI --screenshot mode works because it drives BeginFrames itself, but
// DevTools-driven capture — what Playwright uses — does not. A *headed*
// launch under Xvfb rasterizes normally, so this script probes headless
// rasterization first and falls back to a script-managed Xvfb when needed;
// on hosts where headless works (CI runners, macOS) the probe is a no-op.

const OUT = "pr-shots";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const RASTER_PROBE_TIMEOUT_MS = 8000;
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
    await page.screenshot({ timeout: RASTER_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  } finally {
    if (browser !== undefined) await browser.close().catch(() => undefined);
  }
};

const findFreeDisplay = (): string => {
  for (let n = 99; n <= 120; n += 1)
    if (!existsSync(`/tmp/.X${n}-lock`)) return `:${n}`;
  throw new Error("no free X display number between :99 and :120");
};

const startHeadedDisplay = async (): Promise<{
  display: string;
  xvfb: ChildProcess;
}> => {
  if (!existsSync("/usr/bin/Xvfb") && !existsSync("/usr/local/bin/Xvfb"))
    throw new Error(
      "headless rasterization is unavailable on this host and Xvfb is " +
        "not installed — install it (e.g. `sudo apt install xvfb`) and retry",
    );
  const display = findFreeDisplay();
  const xvfb = spawn("Xvfb", [display, "-screen", "0", "1600x1000x24"], {
    stdio: "ignore",
  });
  const lock = `/tmp/.X${display.slice(1)}-lock`;
  for (let i = 0; i < 50 && !existsSync(lock); i += 1) await sleep(100);
  if (!existsSync(lock)) {
    xvfb.kill("SIGTERM");
    throw new Error(`Xvfb failed to start on ${display}`);
  }
  return { display, xvfb };
};

const launchRasterBrowser = async (): Promise<{
  browser: Browser;
  stop: () => Promise<void>;
}> => {
  if (await headlessRasterWorks()) {
    const browser = await chromium.launch();
    return {
      browser,
      stop: async () => {
        await browser.close();
      },
    };
  }
  console.log(
    "headless rasterization unavailable on this host — " +
      "falling back to a headed launch under Xvfb",
  );
  const { display, xvfb } = await startHeadedDisplay();
  const browser = await chromium.launch({
    headless: false,
    env: { ...process.env, DISPLAY: display },
  });
  return {
    browser,
    stop: async () => {
      await browser.close();
      xvfb.kill("SIGTERM");
    },
  };
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

// The mobile layout boots with the sidebar pane in front; switch to the
// detail pane before shooting whatever the detail pane shows. The toggle
// only appears once the viewport is small enough, so give it a beat.
const showDetailPaneOnMobile = async (page: Page): Promise<void> => {
  const toggle = page.locator('.mobile-pane-btn[data-pane="detail"]');
  await toggle
    .waitFor({ state: "visible", timeout: 3000 })
    .catch(() => undefined);
  if (await toggle.isVisible()) await toggle.click();
};

const env = await gooseFixture.startEnv("glv-shots-");
const workDir = join(env.scratchDir, "project");
mkdirSync(workDir, { recursive: true });
mkdirSync(OUT, { recursive: true });
gooseFixture.seedSessions(env, [
  { id: SESSION_ID, name: "Screenshot Session", workingDir: workDir },
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

const { browser, stop } = await launchRasterBrowser();
try {
  const context = await browser.newContext({ viewport: DESKTOP });
  await context.addCookies([
    {
      name: env.cookieName,
      value: env.cookie.slice(env.cookieName.length + 1),
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();

  await page.goto(env.baseUrl);
  await page.locator("form.new-session-form").waitFor();
  await capture(page, "new-session-desktop.png", "form.new-session-form");

  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await page.locator("form.new-session-form").waitFor();
  await capture(page, "new-session-mobile.png", "form.new-session-form");

  await page.setViewportSize(DESKTOP);
  await page.goto(`${env.baseUrl}/sessions/${SESSION_ID}`);
  await page.locator("form.prompt-bar").waitFor();
  await capture(page, "session-desktop.png");
  await capture(page, "prompt-bar-desktop.png", "form.prompt-bar");

  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await page.locator("form.prompt-bar").waitFor();
  await capture(page, "session-mobile.png");

  await page.close();
  await context.close();
} finally {
  await stop();
  await env.cleanup();
}

console.log(
  `done — ${OUT}/*.png ready; upload to GitHub user-attachments and ` +
    "embed in the PR description (never commit image assets)",
);
