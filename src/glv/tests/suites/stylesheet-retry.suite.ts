import { expect } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The styling rides a <link>, and the browser neither retries a failed
// stylesheet request nor re-fetches it while its cache entry is fresh —
// the reported "detail page comes back as unstyled text" bug. Layout and
// AuthLayout wire a bootstrap that refetches the stylesheet over a fresh
// connection and applies it as a late <style>.

const runStylesheetRetrySuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

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
    const res = await authedFetch(env, `/sessions/${fx.viewId("retry-a")}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<link rel="stylesheet" href="/assets/app.css"/>');
    expect(html).toContain("?retry=");
    expect(html).toContain("previousElementSibling");
    const login = await fetch(`${env.baseUrl}/auth/login`);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("?retry=");
  });

  it("recovers styling automatically when the stylesheet request fails", async () => {
    await withPage(env.context, async (page) => {
      // The first stylesheet request dies mid-connection; the bootstrap's
      // retry goes through afterwards.
      let first = true;
      await page.route("**/assets/app.css*", (route) => {
        if (first) {
          first = false;
          return route.abort("connectionreset");
        }
        return route.continue();
      });
      await page.goto(`${env.baseUrl}/sessions/${fx.viewId("retry-a")}`);
      // The UA serif stack means the stylesheet never landed; with no
      // manual reload, the retry alone must restyle the page.
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
