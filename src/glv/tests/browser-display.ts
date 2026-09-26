import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { type Browser, chromium } from "@playwright/test";
import which from "which";

// Some hosts cannot rasterize headless pages: on WSL2 + recent Chrome
// the headless compositor never produces a frame, so DevTools-driven
// capture — what Playwright uses — hangs forever (screenshots, and
// actionability checks with them). This module is the shared machinery
// for probing headless rasterization and falling back to a headed
// browser under a script-managed Xvfb. Consumers: the vitest global
// setup (display-global-setup.ts, feeding harness.ts browser launches)
// and scripts/shots.mts.

// Environment variable the global setup sets to the fallback display it
// provisioned; browser launches that see it run headed under Xvfb.
const DISPLAY_ENV = "GLV_TEST_X_DISPLAY";

// Generous enough for a cold browser launch on a contended runner; on a
// raster-broken host the timeout is the probe's cost, paid once per run
// by the global setup.
const PROBE_TIMEOUT_MS = 8000;

type HeadlessRaster = "works" | "broken" | "unlaunchable";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A throwaway page load plus screenshot answers the only question that
// matters: can this host turn a headless page into pixels via DevTools?
// "unlaunchable" means the browser itself did not start (e.g. Playwright
// browsers not installed) — no display fallback can help there; a
// headless launch will fail the same way.
const probeHeadlessRaster = async (): Promise<HeadlessRaster> => {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
  } catch {
    return "unlaunchable";
  }
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><p>raster probe</p>");
    await page.screenshot({ timeout: PROBE_TIMEOUT_MS });
    return "works";
  } catch {
    return "broken";
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

// Every Xvfb this process started, so a hard exit cannot leak servers;
// the exit hook is registered once, lazily.
const spawnedXvfbs = new Set<ChildProcess>();
let exitHookRegistered = false;

const killSpawnedXvfbs = (): void => {
  for (const xvfb of spawnedXvfbs) xvfb.kill("SIGTERM");
};

// Starts Xvfb on a free display and waits for its lock file. Returns
// null when the Xvfb binary is not installed — callers decide whether
// that is fatal (scripts/shots.mts) or worth a warn-and-degrade (the
// vitest global setup). Throws when Xvfb is installed but never came
// up.
const startXvfbDisplay = async (
  geometry = "1280x800x24",
): Promise<{ display: string; stop: () => void } | null> => {
  if (which.sync("Xvfb", { nothrow: true }) === null) return null;
  const { display, lock } = findFreeDisplay();
  const xvfb = spawn("Xvfb", [display, "-screen", "0", geometry], {
    stdio: "ignore",
  });
  // A spawn failing asynchronously (binary vanished between the which
  // check and exec) must not crash the process on `error`.
  xvfb.once("error", () => spawnedXvfbs.delete(xvfb));
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once("exit", killSpawnedXvfbs);
  }
  spawnedXvfbs.add(xvfb);
  for (let i = 0; i < 50 && !existsSync(lock); i += 1) await sleep(100);
  if (!existsSync(lock)) {
    xvfb.kill("SIGTERM");
    spawnedXvfbs.delete(xvfb);
    throw new Error(`Xvfb failed to start on ${display}`);
  }
  const stop = (): void => {
    xvfb.kill("SIGTERM");
    spawnedXvfbs.delete(xvfb);
  };
  return { display, stop };
};

// The integration harness launches every browser through here: when the
// global setup provisioned a fallback display, browsers run headed
// under it (headed rasterizes where this host's headless cannot);
// otherwise plain headless, exactly as before.
const launchTestBrowser = (): Promise<Browser> => {
  const display = process.env[DISPLAY_ENV];
  if (display === undefined || display === "") return chromium.launch();
  return chromium.launch({
    headless: false,
    env: { ...process.env, DISPLAY: display },
  });
};

export {
  DISPLAY_ENV,
  launchTestBrowser,
  probeHeadlessRaster,
  startXvfbDisplay,
};
