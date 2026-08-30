import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type IntegrationEnv, withPage } from "../../glv/tests/harness.js";
import { gooseConfigPath } from "../models.js";
import { insertSessions, startIntegrationEnv } from "./integration-harness.js";

// Regression: /sessions/new used to await the model catalogue, which spawns
// `goose acp` and can stall for seconds (10-20s timeouts in acp-catalog).
// The whole New Session form blocked on it, so clicking the sidebar's plus
// button left the previous session's transcript on screen — looking like
// the button had navigated to the last-viewed session. The form must render
// instantly; the picker arrives afterwards via the lazy fragment.
const CONFIG_YAML = `active_provider: zai
providers:
  zai:
    enabled: true
    model: glm-5.3
    configured: true
`;

// Long enough that the stalled boot-time warm-up is still in flight when
// the test clicks (and short enough to stay under the 30s acp guard).
const ACP_STALL_MS = 15000;
// The form must beat the stall by a wide margin; pre-fix it only appeared
// once the catalogue conversation timed out (~10s).
const FORM_BUDGET_MS = 2500;

describe("new session with a slow model catalogue (goose)", () => {
  let env: IntegrationEnv;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "glv-slow-catalogue-"));
    const configYaml = gooseConfigPath({ HOME: home });
    mkdirSync(dirname(configYaml), { recursive: true });
    writeFileSync(configYaml, CONFIG_YAML);

    env = await startIntegrationEnv(
      "glv-slow-cat-",
      { acpDelayMs: ACP_STALL_MS },
      home,
    );
    insertSessions(env.dbs.flavor.sessionsDb, [
      {
        id: "slow-seed",
        name: "Slow Catalogue Seed",
        workingDir: join(env.scratchDir, "seed"),
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  it("renders the form while the catalogue is still stalled", async () => {
    await withPage(env.context, async (page) => {
      await page.setViewportSize({ width: 400, height: 800 });
      await page.goto(`${env.baseUrl}/sessions/slow-seed`);
      await expect(page.locator(".session-title")).toBeVisible();

      // The user-reported gesture: back to the list, then the plus button.
      await page.locator('.mobile-pane-btn[data-pane="sidebar"]').click();
      await page.locator(".new-session-btn").click();

      // Before the fix this swap only landed after the stalled catalogue
      // request finished, leaving the previous session's transcript showing.
      await expect(page.locator("form.new-session-form")).toBeVisible({
        timeout: FORM_BUDGET_MS,
      });
      await expect(page.locator("textarea[name='prompt']")).toBeVisible();
      // The picker is a lazy slot at this point, not a blocking <select>.
      await expect(page.locator(".model-picker-slot")).toBeVisible();
      await expect(page).toHaveURL(/\/sessions\/new$/);
    });
  }, 30000);
});
