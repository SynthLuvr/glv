import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runUxAuditSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  // 14 lines guarantees the autogrow cap (240px) is well above the 5-row
  // baseline of the new-session textarea, so growth is unambiguous.
  const multilineBody = Array.from(
    { length: 14 },
    (_, i) => `Step ${i + 1}`,
  ).join("\n");

  const postForm = (
    path: string,
    body: Record<string, string>,
    htmx = false,
  ): Promise<Response> =>
    authedFetch(env, path, {
      method: "POST",
      body: new URLSearchParams(body),
      ...(htmx ? { headers: { "HX-Request": "true" } } : {}),
    });

  beforeAll(async () => {
    // A long sleep keeps a started run "running" long enough to observe the
    // busy prompt bar and the sidebar's running indicator.
    env = await fx.startEnv("glv-ux-audit-", { sleepMs: 8000 });
    for (const id of ["ux-sel", "ux-run"])
      mkdirSync(join(env.scratchDir, id), { recursive: true });
    fx.seedSessions(env, [
      {
        id: "ux-sel",
        name: "Selected",
        workingDir: join(env.scratchDir, "ux-sel"),
      },
      {
        id: "ux-run",
        name: "Runner",
        workingDir: join(env.scratchDir, "ux-run"),
      },
    ]);
    fx.seedMessages(env, "ux-sel", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ]);
    await postForm("/prompts", { title: "Grower", body: multilineBody });
    await postForm("/prompts", { title: "Modal", body: "Hello {{name}}" });
  }, 90000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("F1: programmatic prompt fill autogrows the textarea", () => {
    it("grows the new-session textarea when a multi-line prompt is inserted", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const ta = page.locator(
          'form.new-session-form textarea[name="prompt"]',
        );
        const initial = await ta.evaluate(
          (el) => (el as HTMLElement).offsetHeight,
        );
        const card = page.locator(".prompt-card").filter({ hasText: "Grower" });
        await card.locator(".prompt-card-btn.use").click();
        const grown = await ta.evaluate(
          (el) => (el as HTMLElement).offsetHeight,
        );
        // A bare `.value =` used to leave the field one-row tall; the input
        // dispatch now drives autogrow up toward the cap.
        expect(grown).toBeGreaterThan(initial);
        expect(grown).toBeGreaterThanOrEqual(200);
      });
    }, 30000);
  });

  describe("F2 + A2: busy prompt bar stays in bounds and running is announced", () => {
    it("keeps the Queue/Stop row from overflowing at tablet width and exposes the run", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await postForm("/sessions/ux-run/prompt", { prompt: "do work" }, true);
        const card = page.locator('.session-item[data-session-id="ux-run"]');
        await expect(card).toHaveAttribute("data-running", "");

        // A2: the running state is announced via sr-only text, not colour only.
        await expect(card.locator(".run-indicator .sr-only")).toHaveText(
          "Running",
        );

        // F2: the busy prompt bar (Queue + Stop) must not force a horizontal
        // scroll on the detail pane in the tablet band.
        await page.setViewportSize({ width: 750, height: 820 });
        await page.goto(`${env.baseUrl}/sessions/ux-run`);
        await expect(page.locator(".queue-btn")).toBeVisible();
        const overflow = await page
          .locator("#detail-pane")
          .evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }, 30000);
  });

  describe("F5: variable modal restores focus to its trigger", () => {
    it("returns focus to the Run button when the modal is cancelled", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const card = page.locator(".prompt-card").filter({ hasText: "Modal" });
        await card.locator(".prompt-card-btn.run").click();
        const dialog = page.locator("dialog.prompt-var-modal");
        await expect(dialog).toBeVisible();
        await dialog.locator(".prompt-cancel-btn").click();
        await expect(dialog).toHaveCount(0);
        // dialog.remove() alone never returned focus; the trigger is restored.
        const action = await page.evaluate(() =>
          document.activeElement?.getAttribute("data-action"),
        );
        expect(action).toBe("run");
      });
    }, 30000);
  });

  describe("D1: primary button text adapts to the theme", () => {
    it("uses dark ink on the accent in dark mode (not washed-out white)", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const send = page.locator(".send-btn").first();
        // Fresh context defaults to light, where white on the accent passes AA.
        const light = await send.evaluate((el) => getComputedStyle(el).color);
        expect(light).toBe("rgb(255, 255, 255)");
        await page.locator(".theme-toggle").click();
        const dark = await send.evaluate((el) => getComputedStyle(el).color);
        expect(dark).not.toBe("rgb(255, 255, 255)");
      });
    }, 30000);
  });

  describe("A1: the open session is marked for assistive tech", () => {
    it("sets aria-current on the selected session's link", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/ux-sel`);
        const link = page.locator(
          '.session-item[data-session-id="ux-sel"] .session-link',
        );
        await expect(link).toHaveAttribute("aria-current", "page");
      });
    }, 30000);
  });

  describe("A3: toggle buttons expose their pressed state", () => {
    it("reflects the theme toggle's active state in aria-pressed", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const toggle = page.locator(".theme-toggle");
        const before = await toggle.getAttribute("aria-pressed");
        expect(["true", "false"]).toContain(before);
        await toggle.click();
        const after = await toggle.getAttribute("aria-pressed");
        expect(after).not.toBe(before);
      });
    }, 30000);

    it("reflects the prompt toolbar and bulk-select toggles", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const groupToggle = page
          .locator(".prompt-toggle")
          .filter({ hasText: "Group by category" });
        await expect(groupToggle).toHaveAttribute("aria-pressed", "false");
        await groupToggle.click();
        // The pressed state arrives with the htmx outerHTML swap response,
        // so the window must cover a full server round trip — which on a
        // contended runner can outlast the default 5s (observed: 14 polls
        // of the pre-swap button).
        await expect(groupToggle).toHaveAttribute("aria-pressed", "true", {
          timeout: 20000,
        });

        // Reveal the bulk bar by checking a session, then toggle select-all.
        await page.locator(".session-check-wrap").first().click();
        const bulk = page.locator("#bulk-toggle");
        await expect(bulk).toBeVisible();
        await expect(bulk).toHaveAttribute("aria-pressed", "false");
        await bulk.click();
        await expect(bulk).toHaveAttribute("aria-pressed", "true");
        await expect(bulk).toHaveText("Deselect all");
      });
    }, 30000);
  });

  describe("A4: icon-only controls and bare inputs are labelled", () => {
    it("labels the filter input, follow-up textarea, and picker summary", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator(".prompt-filter")).toHaveAttribute(
          "aria-label",
          "Filter prompts",
        );

        await page.goto(`${env.baseUrl}/sessions/ux-sel`);
        await expect(page.locator("textarea.prompt-input")).toHaveAttribute(
          "aria-label",
          "Follow-up prompt",
        );
        await expect(
          page.locator(".followup-picker summary.followup-picker-btn"),
        ).toHaveAttribute("aria-label", "Insert a saved prompt");
      });
    }, 30000);
  });

  describe("A5: timestamps carry a machine-readable datetime", () => {
    it("adds datetime to sidebar and message <time> elements", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(`${env.baseUrl}/sessions/ux-sel`);
        const sidebarTime = page.locator(
          '.session-item[data-session-id="ux-sel"] time',
        );
        const sidebarDt = await sidebarTime.getAttribute("datetime");
        expect(sidebarDt).not.toBeNull();
        expect(sidebarDt).toContain("T");

        const messageTime = page.locator(".message-head time").first();
        const messageDt = await messageTime.getAttribute("datetime");
        expect(messageDt).not.toBeNull();
        // ISO form (with a T separator), not the SQLite space-separated value.
        expect(messageDt).toContain("T");
        expect(messageDt).not.toContain(" ");
      });
    }, 30000);
  });

  describe("A6: viewport meta covers notched displays", () => {
    it("includes viewport-fit=cover", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        const content = await page
          .locator('meta[name="viewport"]')
          .getAttribute("content");
        expect(content).toContain("viewport-fit=cover");
      });
    }, 30000);
  });
};

export { runUxAuditSuite };
