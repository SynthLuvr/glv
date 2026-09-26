import {
  DISPLAY_ENV,
  probeHeadlessRaster,
  startXvfbDisplay,
} from "./browser-display.js";

// Vitest global setup: probe headless rasterization once per run and,
// on hosts where it is broken (WSL2 + recent Chrome — the same issue
// scripts/shots.mts probes for), provision one Xvfb display that every
// harness browser launch runs headed under. Without it the
// browser-facing suites hang on Playwright actionability checks there.
// With Xvfb missing there is nothing to fall back to, so warn and
// degrade to plain headless launches (the old behavior). The display
// reaches the harness through the environment: workers fork after
// global setup completes and inherit it.
const setup = async (): Promise<(() => void) | undefined> => {
  const raster = await probeHeadlessRaster();
  if (raster !== "broken") return undefined;
  const started = await startXvfbDisplay();
  if (started === null) {
    console.warn(
      "headless rasterization is unavailable on this host and Xvfb is " +
        "not installed — browser-facing tests may hang; install it " +
        "(e.g. `sudo apt install xvfb`)",
    );
    return undefined;
  }
  process.env[DISPLAY_ENV] = started.display;
  console.log(
    `headless rasterization unavailable on this host — browser tests ` +
      `run headed under Xvfb on ${started.display}`,
  );
  return started.stop;
};

export { setup as default };
