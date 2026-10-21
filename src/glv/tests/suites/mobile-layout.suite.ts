import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runMobileLayoutSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  // Tall enough to overflow the detail pane at a mobile viewport, which makes
  // the scroll-to-latest button appear and exercises scroll behaviour.
  const TALL_MESSAGES = Array.from({ length: 50 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Line ${i}.\n`.repeat(8) }],
  }));

  const VIEWPORT = { width: 400, height: 800 };
  // Roughly the on-screen-keyboard-open geometry of VIEWPORT: what the
  // layout viewport shrinks to under interactive-widget=resizes-content.
  const KEYBOARD_OPEN_VIEWPORT = { width: 400, height: 420 };

  beforeAll(async () => {
    // sleepMs keeps the submitted follow-up running long enough for the
    // busy bar (Queue/Stop) to be measured while it is up.
    env = await fx.startEnv("glv-mobile-layout-", { sleepMs: 20000 });
    fx.seedSessions(env, [
      {
        id: "mobile-tall",
        name: "Mobile Tall",
        workingDir: join(env.scratchDir, "mobile"),
      },
      {
        id: "mobile-tall-2",
        name: "Mobile Tall 2",
        workingDir: join(env.scratchDir, "mobile-2"),
      },
      {
        id: "mobile-composer",
        name: "Mobile Composer",
        workingDir: join(env.scratchDir, "composer"),
      },
      {
        id: "mobile-header",
        name: "Mobile Header Session With A Deliberately Long Wrapping Title",
        workingDir: join(env.scratchDir, "mobile-header-project"),
        model: "header-model",
      },
    ]);
    fx.seedMessages(env, "mobile-tall", TALL_MESSAGES);
    fx.seedMessages(env, "mobile-tall-2", TALL_MESSAGES);
    // The busy-composer test submits a run, and the agent spawns with this
    // workingDir as its cwd.
    mkdirSync(join(env.scratchDir, "composer"), { recursive: true });
    mkdirSync(join(env.scratchDir, "mobile-header-project"), {
      recursive: true,
    });
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  const openMobileDetail = async (
    page: Page,
    id = "mobile-tall",
  ): Promise<void> => {
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${env.baseUrl}/sessions/${fx.viewId(id)}`);
    await expect(page.locator("#detail-pane")).toBeVisible();
  };

  const switchPane = async (
    page: Page,
    pane: "sidebar" | "detail",
  ): Promise<void> => {
    await page.locator(`.mobile-pane-btn[data-pane="${pane}"]`).click();
  };

  // At the phone viewport the title must truncate to one line and the
  // meta row must wrap, never scroll sideways: the Working dir chip has
  // to be visible and tappable where it lands.
  describe("session header collapses on mobile", () => {
    it("keeps the title to one line and wraps the meta row with no sideways overflow", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page, "mobile-header");
        const header = await page.evaluate(() => {
          const title = document.querySelector(
            ".session-header .session-title",
          );
          const meta = document.querySelector(".session-meta");
          const pane = document.querySelector("#detail-pane");
          if (title === null || meta === null || pane === null) return null;
          const workingDir = [...meta.querySelectorAll(".meta-chip")].find(
            (chip) =>
              chip.querySelector(".meta-label")?.textContent === "Working dir",
          );
          const chipRect = workingDir?.getBoundingClientRect();
          const paneRect = pane.getBoundingClientRect();
          return {
            titleHeight: title.getBoundingClientRect().height,
            titleTruncated: title.scrollWidth > title.clientWidth + 1,
            metaScrollable: meta.scrollWidth > meta.clientWidth + 1,
            workingDirInside:
              chipRect !== undefined &&
              chipRect.left >= paneRect.left - 1 &&
              chipRect.right <= paneRect.right + 1,
            paneOverflow: pane.scrollWidth - pane.clientWidth,
          };
        });
        expect(header).not.toBeNull();
        // One line: 1.05rem text on a 1.6 line-height ≈ 27px; a wrap
        // would double it.
        expect(header!.titleHeight).toBeLessThanOrEqual(32);
        expect(header!.titleTruncated).toBe(true);
        // The row wraps instead of scrolling sideways: nothing hides
        // off-screen right, and the Working dir chip lands fully inside
        // the pane — one tap away.
        expect(header!.metaScrollable).toBe(false);
        expect(header!.workingDirInside).toBe(true);
        // And nothing forces the pane itself sideways.
        expect(header!.paneOverflow).toBeLessThanOrEqual(1);
      });
    }, 30000);
  });

  // Read the toggle bar's box straight from the DOM rather than via
  // locator.boundingBox(), which can return null for actionability reasons.
  const expectTopBarWithinViewport = async (page: Page): Promise<void> => {
    const rect = await page.evaluate(() => {
      const el = document.querySelector(".mobile-pane-toggle");
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        display: getComputedStyle(el).display,
      };
    });
    expect(rect).not.toBeNull();
    expect(rect!.display).toBe("flex");
    // The top bar stays flush to the top and fully inside the viewport.
    expect(rect!.top).toBeGreaterThanOrEqual(-0.5);
    expect(rect!.bottom).toBeLessThanOrEqual(VIEWPORT.height);
  };

  describe("mobile scroll-to-latest button", () => {
    it("hides while the sidebar pane is active", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);
        const scrollBtn = page.locator("#scroll-latest");
        // Idle at the top of a long transcript → not near the bottom → shown.
        await expect(scrollBtn).toBeVisible();

        await switchPane(page, "sidebar");
        await expect(page.locator(".app")).toHaveAttribute(
          "data-mobile-pane",
          "sidebar",
        );
        await expect(scrollBtn).toBeHidden();
      });
    }, 30000);

    it("reappears (when not near the bottom) after returning to the detail pane", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);
        const scrollBtn = page.locator("#scroll-latest");
        await expect(scrollBtn).toBeVisible();

        await switchPane(page, "sidebar");
        await expect(scrollBtn).toBeHidden();
        await switchPane(page, "detail");
        await expect(scrollBtn).toBeVisible();
      });
    }, 30000);
  });

  describe("mobile layout stability", () => {
    it("keeps the top bar pinned and the body unscrolled while the detail pane scrolls", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);
        const pane = page.locator("#detail-pane");

        // The transcript must overflow for the scroll to be meaningful.
        const overflow = await pane.evaluate(
          (el) => el.scrollHeight - el.clientHeight,
        );
        expect(overflow).toBeGreaterThan(200);

        await pane.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });

        await expectTopBarWithinViewport(page);

        // Only the inner pane scrolls; overscroll containment keeps the body put.
        const bodyScroll = await page.evaluate(
          () => document.body.scrollTop + document.documentElement.scrollTop,
        );
        expect(bodyScroll).toBe(0);

        // The shell fills the real (dynamic) viewport height.
        const fills = await page.evaluate(() => {
          const app = document.querySelector(".app");
          if (app === null) return false;
          const style = getComputedStyle(app);
          return Math.abs(parseFloat(style.height) - window.innerHeight) < 2;
        });
        expect(fills).toBe(true);
      });
    }, 30000);

    it("keeps the top bar visible after an htmx navigation on mobile", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);
        // Navigate to the other session via the sidebar (htmx swap).
        await switchPane(page, "sidebar");
        await page
          .locator(
            `.session-item[data-session-id="${fx.viewId("mobile-tall-2")}"] .session-name`,
          )
          .click();
        // A contended auth-db busy wait can stretch the navigation past
        // Playwright's 5s default, so allow a full lock window.
        await expect(page).toHaveURL(
          `${env.baseUrl}/sessions/${fx.viewId("mobile-tall-2")}`,
          {
            timeout: 15_000,
          },
        );

        await expectTopBarWithinViewport(page);
      });
    }, 30000);
  });

  // The busy bar packs the picker, attach/location buttons and Queue/Stop
  // around the textarea, the row's only shrinkable item — a phone's width
  // deficit used to collapse the input to a few characters. Assert real
  // geometry at the phone viewport: a typing-usable input, no horizontal
  // overflow.
  describe("prompt bar stays usable on mobile", () => {
    const composerGeometry = async (
      page: Page,
    ): Promise<{ inputWidth: number; overflow: number }> => ({
      inputWidth: await page
        .locator(".prompt-input-row .prompt-input")
        .evaluate((el) => el.getBoundingClientRect().width),
      overflow: await page
        .locator(".prompt-input-row")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    });

    it("keeps the follow-up textarea usable while Queue/Stop are shown", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page, "mobile-composer");
        await page
          .locator('form.prompt-bar textarea[name="prompt"]')
          .fill("Queue a follow-up while the run finishes");
        await page.locator("form.prompt-bar button.send-btn").click();
        await page
          .locator("form.prompt-bar button.stop-btn")
          .waitFor({ timeout: 20000 });

        const { inputWidth, overflow } = await composerGeometry(page);
        expect(inputWidth).toBeGreaterThan(150);
        expect(overflow).toBeLessThanOrEqual(1);
      });
    }, 60000);

    it("keeps the idle textarea usable next to its Send button", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);

        const { inputWidth, overflow } = await composerGeometry(page);
        expect(inputWidth).toBeGreaterThan(200);
        expect(overflow).toBeLessThanOrEqual(1);
      });
    }, 30000);

    it("drops the saved-prompt picker and keeps the row intact", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);

        await expect(
          page.locator(".prompt-input-row .followup-picker"),
        ).toHaveCount(0);

        // With the input owning the first line, the attach button rides the
        // wrapped action row, bottom-aligned with Send.
        const edge = (
          selector: string,
          side: "top" | "bottom",
        ): Promise<number> =>
          page
            .locator(selector)
            .evaluate((el, s) => el.getBoundingClientRect()[s], side);

        const inputBottom = await edge(
          ".prompt-input-row .prompt-input",
          "bottom",
        );
        const paperclipTop = await edge(
          ".prompt-input-row .paperclip-btn",
          "top",
        );
        const paperclipBottom = await edge(
          ".prompt-input-row .paperclip-btn",
          "bottom",
        );
        const sendBottom = await edge(".prompt-input-row .send-btn", "bottom");

        expect(paperclipTop).toBeGreaterThanOrEqual(inputBottom - 0.5);
        expect(Math.abs(paperclipBottom - sendBottom)).toBeLessThanOrEqual(1.5);
      });
    }, 30000);
  });

  // Android Chrome's default keyboard behavior (resizes-visual) pans the
  // visual viewport over the fixed-height shell instead of resizing it.
  // When the focused follow-up textarea is swapped away mid-submit, that
  // pan sticks: the Sessions/Detail toggle ends up above the visible area,
  // unreachable, with dead space below the composer. The viewport meta's
  // interactive-widget=resizes-content opts into the resize behavior, so
  // the shell reflows to the keyboard instead of being panned.
  describe("keyboard resize behavior", () => {
    // The regression lock: the server must serve the opt-in meta on the
    // session page (shared Layout), or Android reverts to the panning
    // behavior that strands the top bar.
    it("serves the session page with interactive-widget=resizes-content", async () => {
      const response = await fetch(
        `${env.baseUrl}/sessions/${fx.viewId("mobile-tall")}`,
      );
      expect(response.ok).toBe(true);
      const html = await response.text();
      expect(html).toContain("interactive-widget=resizes-content");
    }, 30000);

    // The contract resizes-content relies on: when the on-screen keyboard
    // shrinks the layout viewport, the shell must reflow (not overflow) so
    // nothing is stranded outside the visible area — the pane toggle stays
    // pinned on screen, and the composer sits at the pane's scroll bottom
    // rather than behind where the keyboard would be. A shorter viewport
    // reproduces the keyboard-open geometry headlessly.
    it("reflows the shell so the toggle and composer stay reachable at keyboard-open height", async () => {
      await withPage(env.context, async (page) => {
        await openMobileDetail(page);
        await page.setViewportSize(KEYBOARD_OPEN_VIEWPORT);
        // The composer lives at the detail pane's scroll bottom; bring it
        // into view the way a reader reaching for it would.
        await page.locator("#detail-pane").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });

        const geometry = await page.evaluate(() => {
          const rect = (selector: string): DOMRect | null =>
            document.querySelector(selector)?.getBoundingClientRect() ?? null;
          const app = document.querySelector(".app");
          return {
            appHeight: app === null ? 0 : app.getBoundingClientRect().height,
            innerHeight: window.innerHeight,
            bodyScroll:
              document.body.scrollTop + document.documentElement.scrollTop,
            bodyOverflow:
              document.documentElement.scrollHeight -
              document.documentElement.clientHeight,
            toggle: rect(".mobile-pane-toggle"),
            send: rect("form.prompt-bar button.send-btn"),
          };
        });

        // The shell tracks the shrunken viewport exactly — dvh, no pan.
        expect(geometry.appHeight).toBeCloseTo(geometry.innerHeight, 0);
        expect(geometry.bodyScroll).toBe(0);
        expect(geometry.bodyOverflow).toBeLessThanOrEqual(1);
        expect(geometry.toggle).not.toBeNull();
        expect(geometry.toggle!.top).toBeGreaterThanOrEqual(-0.5);
        expect(geometry.toggle!.bottom).toBeLessThanOrEqual(
          geometry.innerHeight,
        );
        // Scrolled to the pane's bottom, the composer is fully on screen:
        // no dead space below it for the keyboard to sit over.
        expect(geometry.send).not.toBeNull();
        expect(geometry.send!.bottom).toBeLessThanOrEqual(geometry.innerHeight);
      });
    }, 30000);
  });
};

export { runMobileLayoutSuite };
