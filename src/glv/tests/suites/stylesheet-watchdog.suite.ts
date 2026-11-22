import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The stylesheet-outage contract behind the phones-render-unstyled bug.
// The tunnel between phones and the server dies in windows the journal
// measures in minutes (restart counter 24, ~20 minutes of flapping on
// 2026-11-11), so the page itself must carry the healing: a real Chromium
// whose app.css requests fail — however many arrive in a row — must end
// up styled again with no manual reload, and must stop asking once the
// sentinel custom property from app.css (the "am I styled?" signal the
// watchdog polls) is present.

const bodyFont = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).fontFamily);

const sentinel = (page: Page): Promise<string> =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--glv-css")
      .trim(),
  );

const runStylesheetWatchdogSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv | undefined;

  beforeAll(async () => {
    env = await fx.startEnv("glv-css-watchdog-");
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it("a healthy load fetches the stylesheet once and applies the sentinel", async () => {
    const e = env;
    if (e === undefined) throw new Error("environment not started");
    await withPage(e.context, async (page) => {
      let served = 0;
      await page.route(/\/assets\/app\.css/, (route) => {
        served += 1;
        return route.continue();
      });
      await page.goto(e.baseUrl);
      await expect
        .poll(() => bodyFont(page), { timeout: 15000 })
        .toContain("system-ui");
      await expect
        .poll(() => sentinel(page), { timeout: 15000 })
        .toBe("loaded");
      // One request, no watchdog churn on the happy path.
      expect(served).toBe(1);
    });
  });

  it("an outage longer than the first-load grace heals without a reload", async () => {
    const e = env;
    if (e === undefined) throw new Error("environment not started");
    await withPage(e.context, async (page) => {
      let released = false;
      let aborted = 0;
      await page.route(/\/assets\/app\.css/, (route) => {
        if (released) return route.continue();
        aborted += 1;
        return route.abort();
      });
      await page.goto(e.baseUrl);
      // The reported shape: the return load renders while the path is down.
      await expect
        .poll(() => bodyFont(page), { timeout: 15000 })
        .toContain("Times");
      // Sustained failure past the first-load grace and several backoff
      // steps — the watchdog must simply keep asking.
      await page.waitForTimeout(20000);
      released = true;
      // No reload, no navigation: the next tick after recovery applies it.
      await expect
        .poll(() => bodyFont(page), { timeout: 30000, intervals: [1000] })
        .toContain("system-ui");
      expect(aborted).toBeGreaterThan(3);
    });
  });

  it("a 200 without the sentinel does not stop the healing", async () => {
    const e = env;
    if (e === undefined) throw new Error("environment not started");
    await withPage(e.context, async (page) => {
      let junked = 0;
      await page.route(/\/assets\/app\.css/, (route) => {
        if (junked >= 2) return route.continue();
        junked += 1;
        return route.fulfill({
          status: 200,
          contentType: "text/css",
          body: "/* junk: looks like css, carries no sentinel */",
        });
      });
      await page.goto(e.baseUrl);
      // The link itself "loads" junk; healing must key off the sentinel,
      // not off the link settling, and keep going until it really applies.
      await expect
        .poll(() => bodyFont(page), { timeout: 30000, intervals: [1000] })
        .toContain("system-ui");
      expect(junked).toBe(2);
    });
  });
};

export { runStylesheetWatchdogSuite };
