import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
} from "@playwright/test";
import { claudeFixture } from "../src/claude/tests/integration-harness.js";
import {
  openSessionLinksDb,
  tagParentSession,
} from "../src/glv/session-links.js";
import {
  openStopNoticesDb,
  recordStopNotice,
} from "../src/glv/stop-notices.js";
import { turnKeyOf } from "../src/glv/suggestions/ask.js";
import {
  openSuggestionsDb,
  putSuggestions,
} from "../src/glv/suggestions/db.js";
import {
  probeHeadlessRaster,
  startXvfbDisplay,
} from "../src/glv/tests/browser-display.js";
import {
  seedClaudeSessions,
  startCombinedEnv,
} from "../src/glv/tests/combined-harness.js";
import type { IntegrationEnv } from "../src/glv/tests/harness.js";
import { seedCronJobRow } from "../src/glv/tests/harness.js";
import {
  LONG_FOLLOW_UP,
  LONG_PROMPT,
} from "../src/glv/tests/suites/cron-ui.suite.js";
import { serveNginx413 } from "../src/glv/tests/suites/upload-413.suite.js";
import { gooseFixture } from "../src/goose/tests/integration-harness.js";

// Local PR-screenshot capture: boots a real `glv serve` on the mock
// integration-test fixture (mock goose agent, seeded session), drives the UI
// with Playwright, and writes PNGs into pr-shots/ (gitignored — upload them
// to GitHub user-attachments, never commit them).
//
// Some hosts cannot rasterize headless pages: on WSL2 + Chrome 153 the
// headless compositor never produces a frame, so DevTools-driven capture —
// what Playwright uses — hangs forever (Chrome's own --screenshot mode
// escapes it only by driving BeginFrames itself). A headed launch under Xvfb
// rasterizes normally, so probe headless capture once up front and fall back
// to a script-managed Xvfb when the probe times out. The probe and Xvfb
// plumbing are shared with the vitest global setup
// (src/glv/tests/browser-display.ts).

const OUT = "pr-shots";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
// Keyboard-open height of MOBILE under interactive-widget=resizes-content.
const MOBILE_KEYBOARD_OPEN = { width: 390, height: 420 };
const SESSION_ID = "shots-1";

// The teardown kills the fallback Xvfb; in headless mode there is nothing
// extra to stop. Xvfb missing on a raster-broken host is fatal here —
// unlike the vitest global setup, this script has no headless fallback
// that could produce the PNGs it exists to capture.
const launchBrowser = async (): Promise<{
  browser: Browser;
  teardown: () => void;
}> => {
  if ((await probeHeadlessRaster()) === "works")
    return { browser: await chromium.launch(), teardown: () => undefined };
  console.log(
    "headless rasterization unavailable on this host — " +
      "falling back to a headed launch under Xvfb",
  );
  const started = await startXvfbDisplay("1600x1000x24");
  if (started === null)
    throw new Error(
      "headless rasterization is unavailable on this host and Xvfb is " +
        "not installed — install it (e.g. `sudo apt install xvfb`) and retry",
    );
  const browser = await chromium.launch({
    headless: false,
    env: { ...process.env, DISPLAY: started.display },
  });
  return { browser, teardown: started.stop };
};

const capture = async (
  page: Page,
  name: string,
  selector?: string,
): Promise<void> => {
  const path = join(OUT, name);
  if (selector === undefined) await page.screenshot({ path });
  else await page.locator(selector).screenshot({ path });
  console.log(`captured ${path}`);
};

// The mobile layout opens with the sidebar pane in front; switch to the
// detail pane before shooting it. The toggle only appears once the viewport
// is narrow, so wait briefly and skip when it never shows.
const showDetailPaneOnMobile = async (page: Page): Promise<void> => {
  const toggle = page.locator('.mobile-pane-btn[data-pane="detail"]');
  await toggle
    .waitFor({ state: "visible", timeout: 3000 })
    .catch(() => undefined);
  if (await toggle.isVisible()) await toggle.click();
};

// The fixture's own browser context is headless, which cannot rasterize on
// the fallback path — this script launches its own browser, so its context
// must carry the auth cookie itself.
const addSessionCookie = async (
  context: BrowserContext,
  env: IntegrationEnv,
): Promise<void> => {
  await context.addCookies([
    {
      name: env.cookieName,
      value: env.dbs.token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
};

const startSeededEnv = async (): Promise<IntegrationEnv> => {
  // sleepMs keeps the busy-composer follow-up running long enough to be
  // captured before the run completes.
  const env = await gooseFixture.startEnv("glv-shots-", { sleepMs: 20000 });
  const workingDir = join(env.scratchDir, "project");
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  gooseFixture.seedSessions(env, [
    { id: SESSION_ID, name: "Screenshot Session", workingDir },
    { id: "shots-limit", name: "Usage Limit Session", workingDir },
    { id: "shots-crash", name: "Crashed Startup Session", workingDir },
    { id: "shots-bg", name: "Background Watch Session", workingDir },
    { id: "shots-scroll", name: "Long Transcript Session", workingDir },
    { id: "shots-orch", name: "Issue loop 2/2 — glv#379, glv#328", workingDir },
    { id: "shots-w379f", name: "glv#379 fix", workingDir },
    { id: "shots-w379r", name: "glv#379 refactor", workingDir },
    { id: "shots-w328f", name: "glv#328 fix", workingDir },
  ]);
  // #385: the loop's worker links, written exactly as the server's create
  // path records them — the sidebar nests the workers under their
  // orchestrator.
  {
    const links = openSessionLinksDb(env.dbs.cronDb);
    for (const worker of ["shots-w379f", "shots-w379r", "shots-w328f"])
      tagParentSession(
        links,
        gooseFixture.viewId(worker),
        gooseFixture.viewId("shots-orch"),
      );
    links.close();
  }
  gooseFixture.seedMessages(env, "shots-limit", [
    {
      role: "user",
      content: [{ type: "text", text: "Run the full migration suite" }],
    },
  ]);
  gooseFixture.seedMessages(env, "shots-bg", [
    {
      role: "user",
      content: [
        { type: "text", text: "Watch PR #394 and report back when CI settles" },
      ],
    },
  ]);
  // A persisted stop notice for the limit session, exactly as the runner
  // records one when the provider refuses service.
  const notices = openStopNoticesDb(env.dbs.stopNoticesDb);
  recordStopNotice(
    notices,
    gooseFixture.viewId("shots-limit"),
    "Session stopped early: provider usage limit reached. " +
      "Rate limit exceeded: usage limit reached. Your quota resets at " +
      "17:01. Send a message to continue.",
  );
  // A persisted run-terminal error, exactly as the runner records one
  // when the agent dies at startup: exit verdict plus the stderr tail.
  recordStopNotice(
    notices,
    gooseFixture.viewId("shots-crash"),
    "goose exited with code 134 — last stderr:\n" +
      "fatal: memory allocation of 1342177280 bytes failed",
  );
  // The drift-tripwire notice, worded exactly as stop-reason.ts
  // classifies an exit-time kill. Held-open stdin (ADR 0010) keeps
  // glv-driven claude runs from producing the epilogue; a future
  // claude that re-introduces it still surfaces this card.
  recordStopNotice(
    notices,
    gooseFixture.viewId("shots-bg"),
    "Session stopped early: pending background tasks were killed when " +
      'the run ended. "CI watcher: sleep 30; until gh pr checks 394" ' +
      "— the agent left background work pending; a headless run cannot " +
      "outlive its turn, so the process killed it on exit and the " +
      "agent will not report back on its own. " +
      "Send a message to continue.",
  );
  notices.close();
  gooseFixture.seedMessages(env, SESSION_ID, [
    {
      role: "user",
      content: [{ type: "text", text: "Draft a release note for v1.4" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Sure — here is a draft release note for v1.4, ready to paste.",
        },
      ],
    },
  ]);
  // Long enough to push the composer below the fold for the placement
  // shots.
  gooseFixture.seedMessages(
    env,
    "shots-scroll",
    Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [
        {
          type: "text",
          text: (
            `Transcript line ${i}: worked through step ${i} of the plan ` +
            "and reported the result back to the session. "
          ).repeat(2),
        },
      ],
    })),
  );
  return env;
};

const captureProxy413 = async (
  page: Page,
  workingDir: string,
): Promise<void> => {
  await serveNginx413(page);
  await page
    .locator('textarea[name="prompt"]')
    .fill("Read the attached screenshot");
  await page.locator('input[name="working_dir"]').fill(workingDir);
  await page.locator("button.send-btn").click();
  await page.locator(".proxy-413-hint").waitFor();
  await capture(page, "proxy-413-desktop.png", "form.new-session-form");
  // Drop the interception so later captures hit the real server.
  await page.unroute("**/sessions");
};

// The suggested-next-prompts surface: a stored suggestion set for the
// seeded session's finished turn (seeded straight into the viewer-owned
// store — the shot needs no live ask), the strip above the input, and
// the accept flow's filled input.
const captureSuggestions = async (
  browser: Browser,
  env: IntegrationEnv,
): Promise<void> => {
  const db = openSuggestionsDb(env.dbs.suggestionsDb);
  putSuggestions(
    db,
    gooseFixture.viewId(SESSION_ID),
    turnKeyOf({ id: SESSION_ID, updated_at: seededUpdatedAt(env) }, 2),
    ["Run the test suite", "Commit these changes", "Explain what you did"],
  );
  db.close();

  const context = await browser.newContext({ viewport: DESKTOP });
  await addSessionCookie(context, env);
  const page = await context.newPage();
  await page.goto(`${env.baseUrl}/sessions/${gooseFixture.viewId(SESSION_ID)}`);
  await page.locator("[data-suggestions]").waitFor();
  await capture(page, "suggestions-desktop.png", "form.prompt-bar");
  await page.locator("[data-suggestion]").nth(1).click();
  await expect(page.locator("textarea.prompt-input")).toHaveValue(
    "Commit these changes",
  );
  await capture(page, "suggestions-accepted-desktop.png", "form.prompt-bar");
  await context.close();
};

// Dark-theme pass over the same key surfaces. The theme bootstrap honors
// the OS preference when nothing is stored, so a `colorScheme: "dark"`
// context lands on the dark palette with no clicks.
const captureDarkViews = async (
  browser: Browser,
  env: IntegrationEnv,
): Promise<void> => {
  const context = await browser.newContext({
    viewport: DESKTOP,
    colorScheme: "dark",
  });
  await addSessionCookie(context, env);
  const page = await context.newPage();

  await page.goto(env.baseUrl);
  await page.locator("form.new-session-form").waitFor();
  await capture(page, "sidebar-dark.png", ".sidebar");
  await capture(page, "new-session-dark.png", "form.new-session-form");

  await page.goto(`${env.baseUrl}/sessions/${gooseFixture.viewId(SESSION_ID)}`);
  await page.locator("form.prompt-bar").waitFor();
  await capture(page, "session-dark.png");
  await capture(page, "prompt-bar-dark.png", "form.prompt-bar");

  await page.goto(
    `${env.baseUrl}/sessions/${gooseFixture.viewId("shots-limit")}`,
  );
  await page.locator("form.prompt-bar .status-hint.error").waitFor();
  await capture(page, "stop-notice-dark.png");

  await context.close();
};

// Composer placement on a long transcript: one viewport shot mid-scroll
// and one at the end, so pinning-over-content or open-page layout
// regressions show up directly in the PR shots.
const capturePromptBarPlacement = async (
  browser: Browser,
  env: IntegrationEnv,
): Promise<void> => {
  const context = await browser.newContext({ viewport: DESKTOP });
  await addSessionCookie(context, env);
  const page = await context.newPage();
  await page.goto(
    `${env.baseUrl}/sessions/${gooseFixture.viewId("shots-scroll")}`,
  );
  const pane = page.locator("#detail-pane");
  await page.locator("form.prompt-bar").waitFor();
  await pane.evaluate((el) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  });
  await capture(page, "session-scrolled-desktop.png");
  await pane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await capture(page, "session-end-desktop.png");
  await context.close();
};

const captureViews = async (
  browser: Browser,
  env: IntegrationEnv,
): Promise<void> => {
  const context = await browser.newContext({ viewport: DESKTOP });
  await addSessionCookie(context, env);
  const page = await context.newPage();

  await page.goto(env.baseUrl);
  await page.locator("form.new-session-form").waitFor();
  await capture(page, "new-session-desktop.png", "form.new-session-form");

  await captureProxy413(page, join(env.scratchDir, "project"));

  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await page.locator("form.new-session-form").waitFor();
  await capture(page, "new-session-mobile.png", "form.new-session-form");

  await page.setViewportSize(DESKTOP);
  await page.goto(`${env.baseUrl}/sessions/${gooseFixture.viewId(SESSION_ID)}`);
  await page.locator("form.prompt-bar").waitFor();
  await capture(page, "session-desktop.png");
  await capture(page, "prompt-bar-desktop.png", "form.prompt-bar");

  // The stop-early notice: a session whose last run was refused by the
  // provider explains why, with the reset time, until it continues.
  await page.goto(
    `${env.baseUrl}/sessions/${gooseFixture.viewId("shots-limit")}`,
  );
  await page.locator("form.prompt-bar .status-hint.error").waitFor();
  await capture(page, "stop-notice-desktop.png");
  await capture(page, "stop-notice-prompt-bar.png", "form.prompt-bar");

  // The crash notice: a session whose last run died at startup keeps the
  // exit verdict and the agent's last stderr lines, surviving reloads.
  await page.goto(
    `${env.baseUrl}/sessions/${gooseFixture.viewId("shots-crash")}`,
  );
  await page.locator("form.prompt-bar .status-hint.error").waitFor();
  await capture(page, "crash-notice-desktop.png");
  await capture(page, "crash-notice-prompt-bar.png", "form.prompt-bar");

  // The drift-tripwire card (unchanged notice-card UI): glv-driven
  // runs no longer produce the kill epilogue (see the bg-wake shots
  // for what really happens), but the classifier stays armed for
  // claude drift — this is the card it would show.
  await page.goto(`${env.baseUrl}/sessions/${gooseFixture.viewId("shots-bg")}`);
  await page.locator("form.prompt-bar .status-hint.error").waitFor();
  await capture(page, "bg-tasks-notice-desktop.png");
  await capture(page, "bg-tasks-notice-prompt-bar.png", "form.prompt-bar");

  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await page.locator("form.prompt-bar").waitFor();
  await capture(page, "session-mobile.png");
  await capture(page, "prompt-bar-mobile.png", "form.prompt-bar");

  // Keyboard-open geometry: the shell must reflow, not pan.
  await page.setViewportSize(MOBILE_KEYBOARD_OPEN);
  await capture(page, "session-mobile-keyboard-open.png");

  // Busy composer (Queue/Stop), captured last: the submitted follow-up
  // stays running for sleepMs and must not leak into the shots above.
  await page.setViewportSize(DESKTOP);
  await page.goto(`${env.baseUrl}/sessions/${gooseFixture.viewId(SESSION_ID)}`);
  await page.locator("form.prompt-bar").waitFor();
  await page
    .locator('form.prompt-bar textarea[name="prompt"]')
    .fill("Queue the changelog pass while this run finishes");
  await page.locator("form.prompt-bar button.send-btn").click();
  await page
    .locator("form.prompt-bar button.stop-btn")
    .waitFor({ timeout: 20000 });
  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await capture(page, "prompt-bar-mobile-busy.png", "form.prompt-bar");

  await context.close();
};

// Enter the tokens screen the way a user does — the sidebar footer link —
// then mint through the real form for the once-only reveal.
const captureTokens = async (browser: Browser, env: IntegrationEnv) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  await addSessionCookie(context, env);
  const page = await context.newPage();
  await page.goto(env.baseUrl);
  await page.locator(".sidebar").waitFor();
  await capture(page, "sidebar-desktop.png", ".sidebar");
  await page.locator("a.api-tokens-link").click();
  await page.locator("form.token-create-form").waitFor();
  await capture(page, "tokens-desktop.png", ".auth-card");
  // The tokens screen is a common phone visit (fetching a token for a
  // script elsewhere), so keep a mobile capture in the set too.
  await page.setViewportSize(MOBILE);
  await capture(page, "tokens-mobile.png", ".auth-card");
  await page.setViewportSize(DESKTOP);
  await page.locator('input[name="name"]').fill("ci");
  await page.locator("form.token-create-form button").click();
  await page.locator(".token-value").waitFor();
  await capture(page, "token-minted-desktop.png", ".auth-card");
  await context.close();
};

// The merged product: one serve, both agents, the combined model picker.
const captureCombined = async (browser: Browser): Promise<void> => {
  const env = await startCombinedEnv("glv-shots-combined-");
  try {
    const workingDir = join(env.scratchDir, "project");
    mkdirSync(workingDir, { recursive: true });
    gooseFixture.seedSessions(env, [
      { id: SESSION_ID, name: "Screenshot Session", workingDir },
    ]);
    seedClaudeSessions(env, [
      { id: "shots-claude", name: "Claude Session", workingDir },
    ]);
    const context = await browser.newContext({ viewport: DESKTOP });
    await addSessionCookie(context, env);
    const page = await context.newPage();
    await page.goto(env.baseUrl);
    await page.locator("form.new-session-form").waitFor();
    await capture(
      page,
      "combined-new-session-desktop.png",
      "form.new-session-form",
    );
    await capture(page, "combined-desktop.png");
    await context.close();
  } finally {
    await env.cleanup();
  }
};

// The fork flow: the action-menu item, the per-message button, and the
// landed fork with its focused prompt bar. Runs on the shared seeded env
// after the main captures so its forks don't leak into earlier shots.
const captureForks = async (browser: Browser, env: IntegrationEnv) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  await addSessionCookie(context, env);
  const page = await context.newPage();

  const id = gooseFixture.viewId(SESSION_ID);
  await page.goto(`${env.baseUrl}/sessions/${id}`);
  await page.locator("form.prompt-bar").waitFor();

  // The action sheet with the new Fork item, open.
  await page.click(".session-menu-toggle");
  await expect(page.locator(".session-menu-panel")).toBeVisible();
  await capture(page, "fork-menu-desktop.png");

  // The hover-revealed per-message fork buttons on a message head.
  await page.keyboard.press("Escape");
  await page.locator(".message[data-msg-index='1']").hover();
  await capture(page, "fork-here-buttons-desktop.png", "#messages");

  // Fork from the second message: the fork lands in the detail pane with
  // the prompt bar focused.
  await page.locator(".message[data-msg-index='1'] .fork-here-btn").click();
  await expect(page.locator(".session-header")).toContainText("(fork)");
  await expect(page.locator("textarea.prompt-input")).toBeFocused();
  await capture(page, "fork-landed-desktop.png");

  // And the mobile bottom-sheet variant of the menu.
  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await page.locator("form.prompt-bar").waitFor();
  await page.click(".session-menu-toggle");
  await expect(page.locator(".session-menu-panel")).toBeVisible();
  await capture(page, "fork-menu-mobile.png");

  await context.close();
};

// The edit form holding a long stored prompt: its prompt and follow-on
// boxes grow to the content (data-autogrow) instead of clipping it
// behind the rows-attribute scroll box.
const captureCronEdit = async (browser: Browser, env: IntegrationEnv) => {
  const workingDir = join(env.scratchDir, "cron-edit");
  mkdirSync(workingDir, { recursive: true });
  seedCronJobRow(env.dbs.cronDb, {
    name: "morning-refresh",
    schedule: "0 6 * * 1-5",
    prompt: LONG_PROMPT,
    workingDir,
    enabled: true,
    followUps: [LONG_FOLLOW_UP],
  });

  const context = await browser.newContext({ viewport: DESKTOP });
  await addSessionCookie(context, env);
  const page = await context.newPage();
  await page.goto(env.baseUrl);
  await page.locator("form.new-session-form").waitFor();
  const card = page.locator('.cron-job-card[data-cron-job="morning-refresh"]');
  await card.getByRole("button", { name: "Edit" }).click();
  const promptBox = card.locator('textarea[name="prompt"]');
  await expect(promptBox).toBeVisible({ timeout: 15_000 });
  await expect(promptBox).toHaveValue(LONG_PROMPT);
  await capture(page, "cron-edit-desktop.png", ".cron-job-card.editing");
  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await capture(page, "cron-edit-mobile.png", ".cron-job-card.editing");
  await context.close();
};

// The Scheduled runs management section with seeded job cards: the
// per-job action row (Run now / Pause / Edit / Delete) is the surface
// cron PRs touch, so it gets its own desktop and mobile pair.
const captureScheduledRuns = async (browser: Browser, env: IntegrationEnv) => {
  const workingDir = join(env.scratchDir, "cron-runs");
  mkdirSync(workingDir, { recursive: true });
  seedCronJobRow(env.dbs.cronDb, {
    name: "nightly-sweep",
    schedule: "0 23 * * 1-5",
    prompt:
      "Research and tell me what was the most profitable trade today. " +
      "Analyze the market moves, then summarize them in the morning note.",
    workingDir,
    enabled: true,
  });
  seedCronJobRow(env.dbs.cronDb, {
    name: "friday-report",
    schedule: "30 8 * * 5",
    prompt:
      "Compile the weekly report from notes/ and post it to the stand-up channel.",
    workingDir,
    timezone: "Europe/Berlin",
    enabled: false,
  });

  const context = await browser.newContext({ viewport: DESKTOP });
  await addSessionCookie(context, env);
  const page = await context.newPage();
  await page.goto(env.baseUrl);
  const section = page.locator("#scheduled-runs");
  await section.waitFor();
  await expect(section).toContainText("nightly-sweep");
  await capture(page, "cron-runs-desktop.png", "#scheduled-runs");
  await page.setViewportSize(MOBILE);
  await showDetailPaneOnMobile(page);
  await capture(page, "cron-runs-mobile.png", "#scheduled-runs");
  await context.close();
};

// The orchestrator loop state (#385): the sidebar with the workers
// nested under their orchestrator, and a worker's header naming the
// orchestrator it belongs to.
const captureOrchestrator = async (browser: Browser, env: IntegrationEnv) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  await addSessionCookie(context, env);
  const page = await context.newPage();
  await page.goto(env.baseUrl);
  await page.locator(".sidebar").waitFor();
  await capture(page, "orchestrator-sidebar-desktop.png", ".sidebar");
  const worker = page.locator(
    ".orchestrator-group .group-members .session-item",
  );
  await worker.first().locator(".session-link").click();
  await page.locator(".session-header").waitFor();
  await expect(page.locator(".parent-chip")).toBeVisible();
  await capture(
    page,
    "orchestrator-worker-header-desktop.png",
    ".session-header",
  );
  await context.close();
};

// The seeded session row's updated_at, as the goose store reads it —
// the suggestion row's turn fingerprint must match it exactly or the
// strip stays hidden.
const seededUpdatedAt = (env: IntegrationEnv): string => {
  const db = new DatabaseSync(env.dbs.flavor.sessionsDb, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT updated_at FROM sessions WHERE id = ?")
      .get(SESSION_ID);
    if (typeof row !== "object" || row === null)
      throw new Error("seeded session row missing");
    const { updated_at } = row;
    if (typeof updated_at !== "string")
      throw new Error("seeded session row has no updated_at");
    return updated_at;
  } finally {
    db.close();
  }
};

// ADR 0010's headline behavior, driven for real against the mock
// claude: the run arms a background watcher, ends its turn, and —
// because glv holds stdin open — stays alive until the watcher
// completes and wakes the agent for its report-back turn. Shot twice:
// mid-park (turn 1 answered, watcher pending, run still going) and
// after the wake turn settles with the promised report.
const captureWakeRun = async (browser: Browser): Promise<void> => {
  const env = await claudeFixture.startEnv(
    "glv-shots-wake-",
    undefined,
    undefined,
    {
      CLAUDE_MOCK_BG_TASKS: "wake",
      // A comfortable window to shoot the parked state before the
      // completion wakes the agent.
      CLAUDE_MOCK_BG_WAKE_DELAY_MS: "9000",
    },
  );
  try {
    const workingDir = join(env.scratchDir, "project");
    mkdirSync(workingDir, { recursive: true });
    claudeFixture.seedSessions(env, [
      { id: "shots-wake", name: "CI watch — PR #394", workingDir },
    ]);
    claudeFixture.seedMessages(env, "shots-wake", [
      {
        role: "user",
        content: [
          { type: "text", text: "The test fix is pushed — keep an eye on CI?" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "On it." }],
      },
    ]);
    const context = await browser.newContext({ viewport: DESKTOP });
    await addSessionCookie(context, env);
    const page = await context.newPage();
    const id = claudeFixture.viewId("shots-wake");
    await page.goto(`${env.baseUrl}/sessions/${id}`);
    await page.locator("form.prompt-bar").waitFor();
    await page
      .locator('form.prompt-bar textarea[name="prompt"]')
      .fill("Watch PR #394 and report back when CI settles");
    await page.locator("form.prompt-bar button.send-btn").click();

    // Mid-park: turn 1 has answered and ended, the watcher is still
    // pending, and the run is alive — stop button up, no settle, no
    // notice. This is the state the old model destroyed.
    await page
      .getByText("Watcher armed; I'll report back")
      .first()
      .waitFor({ timeout: 20000 });
    await page
      .locator("form.prompt-bar button.stop-btn")
      .waitFor({ timeout: 10000 });
    await capture(page, "bg-wake-running-desktop.png");
    await capture(page, "bg-wake-running-prompt-bar.png", "form.prompt-bar");

    // The wake turn: the watcher completed, the agent reports back as
    // promised, and only now does the run settle — the reply lands in
    // the transcript, not just the transient preview.
    await page
      .getByText("reporting back as promised")
      .first()
      .waitFor({ timeout: 30000 });
    await page
      .locator("form.prompt-bar button.send-btn")
      .waitFor({ timeout: 10000 });
    await capture(page, "bg-wake-settled-desktop.png");
    await capture(page, "bg-wake-settled-prompt-bar.png", "form.prompt-bar");
    await context.close();
  } finally {
    await env.cleanup();
  }
};

const env = await startSeededEnv();
const { browser, teardown } = await launchBrowser();
try {
  await captureSuggestions(browser, env);
  await captureViews(browser, env);
  await captureDarkViews(browser, env);
  await capturePromptBarPlacement(browser, env);
  await captureTokens(browser, env);
  await captureOrchestrator(browser, env);
  await captureForks(browser, env);
  await captureCronEdit(browser, env);
  await captureScheduledRuns(browser, env);
  await captureCombined(browser, env);
  await captureWakeRun(browser);
} finally {
  await browser.close();
  teardown();
  await env.cleanup();
}

console.log(
  `done — ${OUT}/*.png ready; upload to GitHub user-attachments and ` +
    "embed in the PR description (never commit image assets)",
);
