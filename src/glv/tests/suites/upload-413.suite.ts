import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The 413 upload path only exists behind a reverse proxy: nginx rejects
// bodies over its limit (1 MB default) with its own error page before the
// glv server — whose body limit is 110 MB — ever sees the request, and
// htmx (configured to swap 4xx bodies so app 422 fragments work) would
// land that foreign page raw in the detail pane. No proxy runs in CI, so
// this suite stands in for that single network hop — the same stand-in
// the no-mock rule allows for external binaries — serving nginx's 413
// page at the network edge while the real server, client scripts, and
// htmx handle everything else.
const NGINX_413_PAGE = `<html>
<head><title>413 Request Entity Too Large</title></head>
<body>
<center><h1>413 Request Entity Too Large</h1></center>
<hr><center>nginx/1.28.3 (Ubuntu)</center>
</body>
</html>
`;

const runUpload413Suite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let workDir: string;

  beforeAll(async () => {
    env = await fx.startEnv("glv-up413-");
    workDir = join(env.scratchDir, "project");
    mkdirSync(workDir, { recursive: true });
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("replaces a proxy 413 with a GLV hint and keeps the typed prompt", async () => {
    await withPage(env.context, async (page) => {
      await page.route("**/sessions", (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        return route.fulfill({
          status: 413,
          contentType: "text/html; charset=utf-8",
          body: NGINX_413_PAGE,
        });
      });

      await page.goto(env.baseUrl);
      await page
        .locator('textarea[name="prompt"]')
        .fill("Read the attached screenshot");
      await page.locator('input[name="working_dir"]').fill(workDir);
      await page.locator("button.send-btn").click();

      // The proxy's error page must not land in the detail pane.
      await expect(page.locator("#detail-pane")).not.toContainText(
        "Request Entity Too Large",
      );
      // A GLV-styled banner explains the rejection and the proxy fix...
      await expect(
        page.locator(".new-session-form .proxy-413-hint"),
      ).toContainText("client_max_body_size");
      // ...and nothing typed is lost to the rejected submit.
      await expect(page.locator('textarea[name="prompt"]')).toHaveValue(
        "Read the attached screenshot",
      );
      await expect(page.locator('input[name="working_dir"]')).toHaveValue(
        workDir,
      );
      // The request lifecycle completed — the disabled submit is back.
      await expect(page.locator("button.send-btn")).toBeEnabled();
    });
  }, 60000);
};

export { runUpload413Suite };
