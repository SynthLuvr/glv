import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  waitForFile,
  withPage,
} from "../harness.js";
import { stdinTranscriptPath } from "../mock-common.js";

// "Share my location" — the geolocation twin of the paperclip upload flow,
// on both the New Session form and the in-session prompt bar.
const runLocationSuite = (fx: FlavorFixture): void => {
  const SESSION_NAME = "Location Test Session";
  const START_PROMPT = "What is near me right now?";
  const FOLLOWUP_PROMPT = "And how far is the nearest cafe?";
  // Greenwich Observatory — any fixed point works; this one is unmistakable.
  const LAT = 51.4778;
  const LON = -0.0015;
  const LAT_FMT = "51.47780";
  const LON_FMT = "-0.00150";

  let env: IntegrationEnv;
  let workDir: string;
  let capturePath: string;

  // waitForFile returns stable content, so a marker-poll is used when the
  // capture file may still hold a previous run's prompt.
  const waitForCaptureMarker = async (marker: string): Promise<string> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        const content = readFileSync(capturePath, "utf-8");
        if (content.includes(marker)) return content;
      } catch {
        // the mock has not written the capture yet — keep polling
      }
      if (Date.now() > deadline)
        throw new Error(`captured prompt never contained "${marker}"`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  beforeAll(async () => {
    capturePath = join(tmpdir(), `glv-loc-cap-${process.pid}.txt`);
    env = await fx.startEnv("glv-loc-", {
      sessionName: SESSION_NAME,
      captureStdin: capturePath,
    });
    workDir = join(env.scratchDir, "project");
    mkdirSync(workDir, { recursive: true });

    fx.seedSessions(env, [
      { id: "loc-followup", name: "Location Follow-up", workingDir: workDir },
    ]);
    fx.seedMessages(env, "loc-followup", [
      { role: "user", content: [{ type: "text", text: "initial prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "initial reply" }] },
    ]);
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("share location — button, chip, and errors", () => {
    it("renders the location button next to the paperclip", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();
        const bar = page.locator("form.new-session-form .location-btn");
        await expect(bar).toBeVisible();
        await expect(bar).toHaveCount(1);
        await expect(
          page.locator("form.new-session-form .paperclip-btn"),
        ).toBeVisible();
        await expect(
          page.locator('form.new-session-form input[name="location"]'),
        ).toHaveCount(1);
      });
    });

    it("shows an error when the browser denies the permission", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();
        // No geolocation grant — headless Chromium denies the request.
        await page.locator("form.new-session-form .location-btn").click();
        const error = page.locator("form.new-session-form .upload-error");
        await expect(error).toBeVisible();
        await expect(error).toContainText(/denied|determined|took too long/);
      });
    });

    it("stages a share chip and removes it on ✕ without submitting", async () => {
      await withPage(env.context, async (page) => {
        await page.context().grantPermissions(["geolocation"]);
        await page.context().setGeolocation({
          latitude: LAT,
          longitude: LON,
          accuracy: 30,
        });
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        await page.locator("form.new-session-form .location-btn").click();
        const chip = page.locator(".location-chip");
        await expect(chip).toBeVisible();
        await expect(chip).toContainText(LAT_FMT);
        await expect(chip).toContainText("Current location");

        const hiddenValue = await page
          .locator('form.new-session-form input[name="location"]')
          .inputValue();
        expect(hiddenValue).toContain(`"latitude":${LAT}`);

        await page.locator(".location-chip .chip-remove").click();
        await expect(page.locator(".location-chip")).toHaveCount(0);
        await expect(
          page.locator('form.new-session-form input[name="location"]'),
        ).toHaveValue("");
      });
    });
  });

  describe("share location — starting a session", () => {
    it(`appends the coordinates to the prompt ${fx.name} receives`, async () => {
      await withPage(env.context, async (page) => {
        await page.context().grantPermissions(["geolocation"]);
        await page.context().setGeolocation({
          latitude: LAT,
          longitude: LON,
          accuracy: 30,
        });
        await page.goto(env.baseUrl);
        await expect(page.locator("form.new-session-form")).toBeVisible();

        await page.locator("form.new-session-form .location-btn").click();
        await expect(page.locator(".location-chip")).toBeVisible();

        await page.locator('input[name="working_dir"]').fill(workDir);
        await page.locator("textarea[name='prompt']").fill(START_PROMPT);
        await page.locator("button.send-btn").click();

        // The transcript, not the latest-stdin capture: the always-on
        // suggestion ask overwrites that once the reply lands.
        const captured = await waitForFile(stdinTranscriptPath(capturePath));
        expect(captured).toContain(START_PROMPT);
        expect(captured).toContain("User's current location");
        expect(captured).toContain(LAT_FMT);
        expect(captured).toContain(LON_FMT);
        expect(captured).toContain("openstreetmap.org");

        // The transcript shows the typed prompt only — the appended
        // location context is for the agent, not the screen.
        await expect(page.locator("#detail-pane")).toContainText(START_PROMPT);
        await expect(page.locator("#detail-pane")).not.toContainText(
          "User's current location",
        );
      });
    }, 60000);
  });

  describe("share location — follow-up prompt", () => {
    it("delivers the location with a follow-up on an existing session", async () => {
      await withPage(env.context, async (page) => {
        await page.context().grantPermissions(["geolocation"]);
        await page.context().setGeolocation({
          latitude: LAT,
          longitude: LON,
          accuracy: 30,
        });
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("loc-followup")}`);
        await expect(page.locator("form.prompt-bar")).toBeVisible();

        await page.locator("form.prompt-bar .location-btn").click();
        await expect(page.locator(".location-chip")).toBeVisible();

        await page.locator("form.prompt-bar textarea").fill(FOLLOWUP_PROMPT);
        // Clear the previous run's capture so the marker poll can't match
        // stale content.
        writeFileSync(capturePath, "");
        await page.locator("form.prompt-bar .send-btn").click();

        const captured = await waitForCaptureMarker(FOLLOWUP_PROMPT);
        expect(captured).toContain("User's current location");
        expect(captured).toContain(LAT_FMT);
      });
    }, 60000);
  });
};

export { runLocationSuite };
