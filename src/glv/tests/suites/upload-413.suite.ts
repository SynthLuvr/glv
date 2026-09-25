import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The 413 upload path only exists behind a reverse proxy: nginx rejects a
// body over its own limit (1 MB by default) with its own error page before
// the glv server ever sees the request. No proxy runs in CI, so this page
// stands in for that one network hop — the same stand-in for an external
// system the no-mock rule allows — while the real server, client scripts,
// and htmx handle everything else.
const NGINX_413_PAGE = `<html>
<head><title>413 Request Entity Too Large</title></head>
<body>
<center><h1>413 Request Entity Too Large</h1></center>
<hr><center>nginx/1.28.3 (Ubuntu)</center>
</body>
</html>
`;

// Answers POSTs to /sessions at the network edge, the way the proxy would.
const serveNginx413 = async (page: Page): Promise<void> => {
  await page.route("**/sessions", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 413,
      contentType: "text/html; charset=utf-8",
      body: NGINX_413_PAGE,
    });
  });
};

const runUpload413Suite = (fx: FlavorFixture): void => {
  const PROMPT_TEXT = "Read the attached screenshot";

  let env: IntegrationEnv;
  let workDir: string;

  beforeAll(async () => {
    env = await fx.startEnv("glv-up413-");
    workDir = join(env.scratchDir, "project");
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("replaces a proxy 413 with a GLV hint and keeps the typed prompt", async () => {
    await withPage(env.context, async (page) => {
      await serveNginx413(page);

      await page.goto(env.baseUrl);
      await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
      await page.locator('input[name="working_dir"]').fill(workDir);
      await page.locator("button.send-btn").click();

      await expect(page.locator("#detail-pane")).not.toContainText(
        "Request Entity Too Large",
      );
      await expect(
        page.locator(".new-session-form .proxy-413-hint"),
      ).toContainText("client_max_body_size");
      await expect(page.locator('textarea[name="prompt"]')).toHaveValue(
        PROMPT_TEXT,
      );
      await expect(page.locator('input[name="working_dir"]')).toHaveValue(
        workDir,
      );
      // The rejected submit completed, so the disabled send button is back.
      await expect(page.locator("button.send-btn")).toBeEnabled();
    });
  }, 60000);
};

export { runUpload413Suite, serveNginx413 };
