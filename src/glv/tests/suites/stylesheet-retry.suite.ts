import { expect } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The stylesheet rides a <link>, and a failed stylesheet request is
// otherwise fatal for the page's appearance until a manual reload: the
// browser neither retries it nor re-fetches it while the cache entry is
// fresh. A transient transport failure (tunnel flap, mobile network
// handover) during the one load that actually fetches the stylesheet is
// the reported "detail page comes back as unstyled text" bug. Layout and
// AuthLayout therefore wire a retry bootstrap that refetches the
// stylesheet over a fresh connection and applies it as a late <style>.

const runStylesheetRetrySuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv | undefined;

  beforeAll(async () => {
    env = await fx.startEnv("glv-style-retry-");
    fx.seedSessions(env, [
      { id: "retry-a", name: "Retry Case", workingDir: env.scratchDir },
    ]);
  }, 240000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("wires the retry bootstrap under the stylesheet link", async () => {
    const res = await authedFetch(env!, `/sessions/${fx.viewId("retry-a")}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<link rel="stylesheet" href="/assets/app.css"/>');
    expect(html).toContain("?retry=");
    expect(html).toContain("previousElementSibling");
    const login = await fetch(`${env!.baseUrl}/auth/login`);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("?retry=");
  });

  it("recovers styling automatically when the stylesheet request fails", async () => {
    const e = env;
    if (e === undefined) throw new Error("environment not started");
    await withPage(e.context, async (page) => {
      await page.setViewportSize({ width: 412, height: 915 });
      // The first stylesheet request dies mid-connection; any later
      // attempt (the bootstrap's retry) goes through.
      let first = true;
      await page.route("**/assets/app.css*", (route) => {
        if (first) {
          first = false;
          return route.abort("connectionreset");
        }
        return route.continue();
      });
      await page.goto(`${e.baseUrl}/sessions/${fx.viewId("retry-a")}`);
      // No manual reload: the retry must land the stylesheet and the
      // page must end up styled (the UA serif stack means it did not).
      await expect
        .poll(
          () => page.evaluate(() => getComputedStyle(document.body).fontFamily),
          { timeout: 15000 },
        )
        .toContain("system-ui");
    });
  });
};

export { runStylesheetRetrySuite };
