import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// Regression proofs for four UI bugs:
//
// 1. htmx 2 silently discards 4xx/5xx responses, so the server's carefully
//    rendered validation errors (422 fragments) never reached the page —
//    rejected submits looked like dead buttons. The client now reconfigures
//    htmx's responseHandling to swap them.
// 2. The sidebar's open-session highlight (a client-side concern) was
//    wiped by every server re-render of the list (rename's OOB refresh,
//    group operations).
// 3. The sidebar's session-count badge only rendered on full page loads,
//    so it went stale after archive/delete until a reload.
// 4. Files staged in the prompt bar were silently dropped when the
//    busy/idle transition swapped the bar's form node.
const runUiFixesSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;
  let workDir: string;
  let uploadFile: string;

  beforeAll(async () => {
    // sleepMs keeps the started run "running" long enough to stage chips
    // in the busy prompt bar before the bar swaps to idle.
    env = await fx.startEnv("glv-ui-fixes-", {
      sessionName: "Ui Fixes Session",
      sleepMs: 6000,
    });
    workDir = join(env.scratchDir, "fixes-project");
    mkdirSync(workDir, { recursive: true });
    uploadFile = join(env.scratchDir, "staged-notes.txt");
    writeFileSync(uploadFile, "staged for a follow-up");
    fx.seedSessions(env, [
      {
        id: "fix-alpha",
        name: "Alpha",
        workingDir: join(env.scratchDir, "dir-a"),
      },
      {
        id: "fix-beta",
        name: "Beta",
        workingDir: join(env.scratchDir, "dir-b"),
      },
    ]);
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("rejected submits surface their error fragment", () => {
    it("shows the new-session 422 banner and keeps the typed prompt", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await page
          .locator('textarea[name="prompt"]')
          .fill("Summarize the release notes");
        await page
          .locator('input[name="working_dir"]')
          .fill(join(env.scratchDir, "missing-dir"));
        await page.locator("button.send-btn").click();

        await expect(page.locator(".status-hint.error")).toContainText(
          "That working directory does not exist.",
        );
        // Nothing typed may be lost to a rejected submit.
        await expect(page.locator('textarea[name="prompt"]')).toHaveValue(
          "Summarize the release notes",
        );
      });
    });

    it("shows the schedule form's 422 validation error", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await page.locator('[data-action="open-schedule"]').click();
        const form = page.locator('[data-schedule-form="save"]');
        await form.waitFor();
        await form.locator('input[name="job_name"]').fill("bad name!");
        await form
          .locator("input[data-schedule-input]")
          .fill("every weekday at 9:00");
        // The schedule form pulls the prompt from the New Session form
        // above at submit time; the server checks it before the job name.
        await page
          .locator('form.new-session-form textarea[name="prompt"]')
          .fill("Prompt for the scheduled run");
        const submit = form.locator("[data-schedule-submit]");
        await expect(submit).toBeEnabled({ timeout: 10000 });
        await submit.click();

        await expect(form.locator(".status-hint.error")).toContainText(
          "Job names start with",
        );
      });
    });
  });

  describe("sidebar state survives list swaps", () => {
    it("keeps the open session highlighted after a rename", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await page.locator('.session-link[href="/sessions/fix-alpha"]').click();
        await expect(
          page.locator('.session-item[data-session-id="fix-alpha"]'),
        ).toHaveClass(/selected/);

        await page.locator(".session-header .rename-pencil").click();
        const input = page.locator("#session-title-wrap .rename-input");
        await input.waitFor();
        await input.fill("Alpha renamed");
        await input.press("Enter");

        await expect(page.locator("#session-list")).toContainText(
          "Alpha renamed",
        );
        await expect(
          page.locator('.session-item[data-session-id="fix-alpha"]'),
        ).toHaveClass(/selected/);
      });
    });

    it("updates the session-count badge after archiving", async () => {
      await withPage(env.context, async (page) => {
        page.on("dialog", (dialog) => void dialog.accept());
        await page.goto(env.baseUrl);
        await expect(page.locator("#session-count")).toHaveText("2");

        await page.locator('.session-link[href="/sessions/fix-beta"]').click();
        await page.locator(".archive-btn").click();
        await expect(page.locator(".new-session-form")).toBeVisible();
        await expect(
          page.locator('.session-item[data-session-id="fix-beta"]'),
        ).toHaveCount(0);
        await expect(page.locator("#session-count")).toHaveText("1");
      });
    });
  });

  describe("staged attachments survive the prompt-bar swap", () => {
    it("keeps the chip when a running session goes idle", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await page
          .locator('textarea[name="prompt"]')
          .fill("Review staged-notes.txt");
        await page.locator('input[name="working_dir"]').fill(workDir);
        await page.locator("button.send-btn").click();
        await page
          .locator(".archive-btn")
          .waitFor({ state: "visible", timeout: 20000 });

        // While the run is active the bar shows Queue/Stop; stage a file
        // and a draft for a follow-up.
        await page
          .locator(".prompt-bar button.stop-btn")
          .waitFor({ timeout: 20000 });
        await page
          .locator('.prompt-bar input[type="file"]')
          .setInputFiles(uploadFile);
        await expect(page.locator(".upload-chip")).toBeVisible();
        await page
          .locator(".prompt-bar textarea")
          .fill("Now iterate on the notes");

        // The run completes; the bar swaps Queue/Stop → Send.
        await page
          .locator(".prompt-bar button.send-btn")
          .waitFor({ state: "visible", timeout: 20000 });

        await expect(page.locator(".upload-chip")).toBeVisible();
        await expect(page.locator(".prompt-bar textarea")).toHaveValue(
          "Now iterate on the notes",
        );
      });
    });
  });
};

export { runUiFixesSuite };
