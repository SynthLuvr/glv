import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// Regression proofs for five bugs where the UI silently lost state: htmx
// 2's default responseHandling discarded 4xx/5xx responses, so the server's
// 422 validation fragments never rendered (rejected submits looked like
// dead buttons); server re-renders of the session list wiped the
// client-side open-session highlight; the session-count badge only rendered
// on full page loads; the busy/idle prompt-bar swap dropped files staged
// for a follow-up; and the scroll-to-latest button lost its click listener
// when a history restore replayed a snapshot clone. The later blocks pin
// the issue-314 UI polish (sidebar fit, reduced motion, focus reveals,
// keyboard rings); the model-picker gate proof lives in goose's
// model-select suite, where a configured default guarantees the picker
// renders at all.
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
      {
        id: "fix-tall",
        name: "Tall",
        workingDir: join(env.scratchDir, "dir-tall"),
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
    // Tall transcript for the scroll-to-latest regression: the scroll
    // distance must clear the 160px near-bottom gate so the button shows.
    fx.seedMessages(
      env,
      "fix-tall",
      Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Filler ${i}.\n`.repeat(8) }],
      })),
    );
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
        await expect(page.locator("#session-count")).toHaveText("3");

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
        await expect(page.locator("#session-count")).toHaveText("2", {
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
        const overflow = await page
          .locator(".sidebar-head")
          .evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }, 30000);

    it("fits the logout control fully inside the sidebar footer", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        // The old header placement clipped the glyph past the sidebar's
        // right edge; the whole button must sit inside the footer row and
        // the sidebar box.
        const fit = await page
          .locator(".sidebar-foot .logout-btn")
          .evaluate((btn) => {
            const box = btn.getBoundingClientRect();
            const inside = (host: Element | null): boolean => {
              if (host === null) return false;
              const h = host.getBoundingClientRect();
              return (
                box.left >= h.left - 0.5 &&
                box.right <= h.right + 0.5 &&
                box.top >= h.top - 0.5 &&
                box.bottom <= h.bottom + 0.5
              );
            };
            return {
              footer: inside(document.querySelector(".sidebar-foot")),
              sidebar: inside(document.querySelector(".sidebar")),
            };
          });
        expect(fit.footer).toBe(true);
        expect(fit.sidebar).toBe(true);
      });
    }, 30000);
  });

  describe("reduced motion", () => {
    it("stops the running-dot pulse under prefers-reduced-motion", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        // Start a run through the real endpoint; the 6s mock sleep keeps
        // the dot pulsing while styles are read.
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
          // Computed durations are seconds ("1e-05s"); normalize to ms.
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
        // Assert the cascade, not transition timing: under the Xvfb headed
        // fallback the document timeline can stall mid-transition, freezing
        // the load-time fade. Kill transitions so computed styles reflect
        // the rules exactly.
        await page.addStyleTag({
          content: "*, *::before, *::after { transition: none !important; }",
        });
        // The Xvfb fallback's real pointer parks mid-screen and can hover a
        // message head, tripping the hover reveal — park it in the corner
        // so only focus drives the assertions.
        await page.mouse.move(1, 1);
        const output = page.locator(".message.output").first();
        const copy = output.locator(".copy-md-btn");
        const fork = output.locator(".fork-here-btn");
        const opacityOf = (btn: Locator): Promise<string> =>
          btn.evaluate((el) => getComputedStyle(el).opacity);

        // Hidden (opacity 0) until something inside the message has focus…
        expect(await opacityOf(copy)).toBe("0");
        expect(await opacityOf(fork)).toBe("0");

        // …then focusing the rendered markdown link reveals both.
        await output.locator(".markdown a").focus();
        expect(await opacityOf(copy)).toBe("1");
        expect(await opacityOf(fork)).toBe("1");
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

  describe("scroll-to-latest button survives history restore", () => {
    // Back/Forward replays htmx's body snapshot, so the live button dies
    // with the old nodes and a listener-less clone is restored — it still
    // shows/hides (the pane scroll listener re-binds), so only a click can
    // tell the difference.
    it("scrolls again after Back restores the page", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/${fx.viewId("fix-tall")}`);
        const btn = page.locator("#scroll-latest");
        await expect(btn).toBeVisible();

        // Leave the page so htmx snapshots it into its history cache
        // (button included), then restore it with Back.
        await page
          .locator(`.session-link[href='/sessions/${fx.viewId("fix-alpha")}']`)
          .click();
        await expect(page.locator("#detail-pane")).toContainText(
          "Check the docs",
        );
        await page.goBack();
        await expect(btn).toBeVisible();

        // A fresh context parks the pane at the top, so a working click
        // moves it far while a dead clone leaves it put.
        const scrollTopOf = (): Promise<number> =>
          page.evaluate(
            () => document.getElementById("detail-pane")?.scrollTop ?? -1,
          );
        const before = await scrollTopOf();
        expect(before).toBeGreaterThanOrEqual(0);
        await btn.click();
        await expect
          .poll(scrollTopOf, { timeout: 5000 })
          .toBeGreaterThan(before + 100);
      });
    }, 30000);
  });
};

export { runUiFixesSuite };
