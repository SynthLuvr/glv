import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gooseFixture } from "../src/goose/tests/integration-harness.js";

// TEMPORARY screenshot generator for the share-location PR description.
// Boots a real `glv-goose serve` against the mock goose agent (exactly like
// the integration harness), drives the new location button with Playwright,
// and writes PNGs into pr-shots/. Deleted from the branch once the PR
// images are uploaded to GitHub user-attachments.
const OUT = "pr-shots";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const LAT = 51.4778;
const LON = -0.0015;

const env = await gooseFixture.startEnv("glv-shots-", {
  sessionName: "Screenshot Session",
});
await env.context.grantPermissions(["geolocation"]);
await env.context.setGeolocation({
  latitude: LAT,
  longitude: LON,
  accuracy: 24,
});

const workDir = join(env.scratchDir, "project");
mkdirSync(workDir, { recursive: true });
gooseFixture.seedSessions(env, [
  { id: "shots-1", name: "Demo Session", workingDir: workDir },
]);
gooseFixture.seedMessages(env, "shots-1", [
  { role: "user", content: [{ type: "text", text: "initial prompt" }] },
  {
    role: "assistant",
    content: [{ type: "text", text: "Sure — here is a mock reply." }],
  },
]);

const page = await env.context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(env.baseUrl);
await page.locator("form.new-session-form .location-btn").waitFor();
await page.locator("form.new-session-form").screenshot({
  path: `${OUT}/new-session-before.png`,
});

await page.locator("form.new-session-form .location-btn").click();
await page.locator(".location-chip").waitFor();
await page.locator("form.new-session-form").screenshot({
  path: `${OUT}/new-session-after.png`,
});
await page.screenshot({ path: `${OUT}/new-session-after-full.png` });

await page.setViewportSize({ width: 390, height: 844 });
// The New Session page boots with the sidebar pane active on mobile;
// switch to the detail pane before shooting the form.
await page.locator('.mobile-pane-btn[data-pane="detail"]').click();
await page.locator("form.new-session-form").waitFor();
await page.locator("form.new-session-form").screenshot({
  path: `${OUT}/new-session-mobile.png`,
});

await page.goto(`${env.baseUrl}/sessions/shots-1`);
await page.locator("form.prompt-bar").waitFor();
await page.locator("form.prompt-bar .location-btn").click();
await page.locator(".location-chip").waitFor();
await page.setViewportSize({ width: 1280, height: 800 });
await page.locator("form.prompt-bar").screenshot({
  path: `${OUT}/prompt-bar-desktop.png`,
});
await page.setViewportSize({ width: 390, height: 844 });
await page.locator("form.prompt-bar").screenshot({
  path: `${OUT}/prompt-bar-mobile.png`,
});

await page.close();
await env.cleanup();
console.log(`shots written to ${OUT}`);
