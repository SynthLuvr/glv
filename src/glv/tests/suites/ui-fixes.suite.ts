import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// Regression proofs for four bugs where the UI silently lost state:
// htmx 2's default responseHandling discarded 4xx/5xx responses, so the
// server's 422 validation fragments never rendered (rejected submits looked
// like dead buttons); server re-renders of the session list wiped the
// client-side open-session highlight; the session-count badge only rendered
// on full page loads; and the busy/idle prompt-bar swap dropped files
// staged for a follow-up. Later describe blocks add the UI-polish
// regression proofs (sidebar fit, reduced motion, focus reveals, keyboard
// rings) from the issue-314 fixes. The model-picker gate proof lives in
// goose's model-select suite, where a configured default guarantees the
// picker renders at all.
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
    mkdirSync(join(env.scratchDir, "dir-a"), { recursive: true });
    mkdirSync(join(env.scratchDir, "dir-b"), { recursive: true });
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
    // A rendered markdown link inside an output message: focusing it (or
    // anything else inside a message) must reveal the hover-only controls.
    fx.seedMessages(env, "fix-alpha", [
      { role: "user", content: [{ type: "text", text: "Check the docs" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See [the guide](https://example.com/docs) for details.",
          },
        ],
      },
    ]);
  }, 180000);

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
        await page
          .locator(`.session-link[href='/sessions/${fx.viewId("fix-alpha")}']`)
          .click();
        await expect(
          page.locator(
            `.session-item[data-session-id="${fx.viewId("fix-alpha")}"]`,
          ),
        ).toHaveClass(/selected/);

        await page.locator(".session-header .rename-pencil").click();
        const input = page.locator("#session-title-wrap .rename-input");
        await input.waitFor();
        await input.fill("Alpha renamed");
        await input.press("Enter");

        // Like the oob-swap rename proof: on a contended runner the
        // rename POST's response (title fragment + sidebar swap) can
        // outlast the default 5s window.
        await expect(page.locator("#session-list")).toContainText(
          "Alpha renamed",
          { timeout: 10000 },
        );
        await expect(
          page.locator(
            `.session-item[data-session-id="${fx.viewId("fix-alpha")}"]`,
          ),
        ).toHaveClass(/selected/);
      });
    });

    it("updates the session-count badge after archiving", async () => {
      await withPage(env.context, async (page) => {
        page.on("dialog", (dialog) => void dialog.accept());
        await page.goto(env.baseUrl);
        await expect(page.locator("#session-count")).toHaveText("2");

        await page
          .locator(`.session-link[href='/sessions/${fx.viewId("fix-beta")}']`)
          .click();
        await page.locator(".archive-btn").click();
        // One archive response drives the detail-pane swap and the sidebar
        // out-of-band swaps; on a contended runner the round trip can
        // outlast the default 5s expect window, so grant each leg the 20s
        // budget the staged-attachments test below uses.
        await expect(page.locator(".new-session-form")).toBeVisible({
          timeout: 20000,
        });
        await expect(
          page.locator(
            `.session-item[data-session-id="${fx.viewId("fix-beta")}"]`,
          ),
        ).toHaveCount(0, { timeout: 20000 });
        await expect(page.locator("#session-count")).toHaveText("1", {
          timeout: 20000,
        });
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

  describe("sidebar header and footer fit their controls", () => {
    it("keeps the header row free of horizontal clipping", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const overflow = await page.evaluate(() => {
          const head = document.querySelector(".sidebar-head");
          return head === null ? null : head.scrollWidth - head.clientWidth;
        });
        expect(overflow).not.toBeNull();
        expect(overflow!).toBeLessThanOrEqual(0);
      });
    }, 30000);

    it("fits the logout control fully inside the sidebar footer", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const fit = await page.evaluate(() => {
          const foot = document.querySelector(".sidebar-foot");
          const btn = document.querySelector(".sidebar-foot .logout-btn");
          const sidebar = document.querySelector(".sidebar");
          if (foot === null || btn === null || sidebar === null) return null;
          const f = foot.getBoundingClientRect();
          const b = btn.getBoundingClientRect();
          const s = sidebar.getBoundingClientRect();
          return { b, f, s };
        });
        expect(fit).not.toBeNull();
        // Fully inside the footer row…
        expect(fit!.b.left).toBeGreaterThanOrEqual(fit!.f.left - 0.5);
        expect(fit!.b.right).toBeLessThanOrEqual(fit!.f.right + 0.5);
        expect(fit!.b.top).toBeGreaterThanOrEqual(fit!.f.top - 0.5);
        expect(fit!.b.bottom).toBeLessThanOrEqual(fit!.f.bottom + 0.5);
        // …and inside the sidebar itself (the old header placement clipped
        // the glyph past the sidebar's right edge).
        expect(fit!.b.right).toBeLessThanOrEqual(fit!.s.right + 0.5);
      });
    }, 30000);
  });

  describe("reduced motion", () => {
    it("stops the running-dot pulse under prefers-reduced-motion", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        // Start a run on the seeded session through the real endpoint; the
        // 6s mock sleep keeps the dot pulsing while styles are read.
        await fetch(
          `${env.baseUrl}/sessions/${fx.viewId("fix-alpha")}/prompt`,
          {
            method: "POST",
            body: new URLSearchParams({ prompt: "pulse the run dot" }),
            headers: { cookie: env.cookie },
          },
        );
        const item = page.locator(
          `.session-item[data-session-id="${fx.viewId("fix-alpha")}"]`,
        );
        await expect(item).toHaveAttribute("data-running", "", {
          timeout: 15000,
        });
        const dot = item.locator(".run-dot");

        const pulsing = await dot.evaluate(
          (el) => getComputedStyle(el).animationDuration,
        );
        expect(pulsing).toBe("1.6s");

        await page.emulateMedia({ reducedMotion: "reduce" });
        const still = await dot.evaluate((el) => {
          const style = getComputedStyle(el);
          // Computed durations come back in seconds ("1e-05s") — normalize
          // to milliseconds before comparing.
          const ms = parseFloat(style.animationDuration) * 1000;
          return `${ms}/${style.animationIterationCount}`;
        });
        expect(still).toBe("0.01/1");
      });
    }, 30000);
  });

  describe("hover-revealed controls respond to keyboard focus", () => {
    it("reveals copy and fork buttons when a message child is focused", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("fix-alpha")}`);
        // The reveal is a cascade question (:focus-within selectors), not a
        // transition-timing one — and on hosts that fall back to a headed
        // launch under Xvfb the document timeline can stall mid-transition,
        // freezing the load-time 1→0 fade. Kill transitions so computed
        // styles reflect the rules exactly.
        await page.addStyleTag({
          content: "*, *::before, *::after { transition: none !important; }",
        });
        // On hosts that fall back to a headed launch under Xvfb, the real
        // pointer parks mid-screen and can hover a message head, tripping
        // the hover reveal. Park it in the corner so only focus drives the
        // assertions.
        await page.mouse.move(1, 1);
        const output = page.locator(".message.output").first();
        const copy = output.locator(".copy-md-btn");
        const fork = output.locator(".fork-here-btn");

        // Hidden (opacity 0) until something inside the message has focus.
        expect(await copy.evaluate((el) => getComputedStyle(el).opacity)).toBe(
          "0",
        );
        expect(await fork.evaluate((el) => getComputedStyle(el).opacity)).toBe(
          "0",
        );

        // Tab-equivalent: focusing a link inside the rendered markdown
        // must reveal the wrap's copy button and the message's fork button.
        await output.locator(".markdown a").focus();
        expect(await copy.evaluate((el) => getComputedStyle(el).opacity)).toBe(
          "1",
        );
        expect(await fork.evaluate((el) => getComputedStyle(el).opacity)).toBe(
          "1",
        );
      });
    }, 30000);
  });

  describe("keyboard focus rings", () => {
    // Real Tab presses so :focus-visible matches the way it does for
    // keyboard users; programmatic focus() does not set that state.
    const tabUntil = async (page: Page, selector: string): Promise<void> => {
      let focused = false;
      for (let i = 0; i < 60 && !focused; i++) {
        await page.keyboard.press("Tab");
        focused = await page.evaluate(
          (sel) => document.activeElement?.matches(sel) === true,
          selector,
        );
      }
      expect(focused, `Tab never reached ${selector}`).toBe(true);
    };

    const outlineOf = (page: Page, selector: string): Promise<string> =>
      page.locator(selector).evaluate((el) => {
        const style = getComputedStyle(el);
        return `${style.outlineStyle} ${style.outlineWidth}`;
      });

    it("rings the Send button", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await tabUntil(page, "button.send-btn");
        expect(await outlineOf(page, "button.send-btn")).toContain("solid");
      });
    }, 30000);

    it("rings the Archive button on a session page", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("fix-alpha")}`);
        await tabUntil(page, "button.archive-btn");
        expect(await outlineOf(page, "button.archive-btn")).toContain("solid");
      });
    }, 30000);
  });
};

export { runUiFixesSuite };
