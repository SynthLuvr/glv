import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  authedFetch,
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

const runViewerSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-viewer-");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("web viewer shell", () => {
    it("announces one glv product naming the served agents", () => {
      // The merged product has one name; single-agent machines must not
      // see the retired glv-goose/glv-claude product names.
      const stdout = env.serverStdout();
      expect(stdout).toContain(`glv web viewer (${fx.name}) → `);
      expect(stdout).not.toContain("glv-goose");
      expect(stdout).not.toContain("glv-claude");
    });

    it("shows an empty state and the new-session form when there are no sessions", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator(".sidebar .empty")).toContainText(
          "No sessions found",
        );
        await expect(page.locator(".session-count")).toHaveText("0");
        await expect(page.locator("form.new-session-form")).toBeVisible();
        await expect(page.locator('textarea[name="prompt"]')).toBeVisible();
        await expect(page.locator("button.send-btn")).toHaveText(
          "Start session",
        );
      });
    });

    it("lists sessions in the sidebar once they exist", async () => {
      fx.seedSessions(env, [
        {
          id: "viewer-alpha",
          name: "Alpha Session",
          workingDir: join(env.scratchDir, "alpha"),
        },
        {
          id: "viewer-beta",
          name: "Beta Session",
          workingDir: join(env.scratchDir, "beta"),
        },
      ]);
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator("#session-list")).toBeVisible();
        await expect(page.locator(".session-item")).toHaveCount(2);
        await expect(page.locator("#session-list")).toContainText(
          "Alpha Session",
        );
        await expect(page.locator(".session-count")).toHaveText("2");
      });
    });

    it("swaps only the detail pane on sidebar navigation, keeping the list", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await page.locator(".session-link").first().click();
        await expect(page.locator("#detail-pane .detail-inner")).toBeVisible();
        await expect(page.locator("#session-list")).toBeVisible();
      });
    });

    it("renders a mobile pane toggle defaulting to the sidebar", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(page.locator(".mobile-pane-toggle")).toBeAttached();
        await page.locator(".session-link").first().click();
        await expect(page.locator("#detail-pane .detail-inner")).toBeVisible();
      });
    });

    it("adds a selection checkbox, bulk bar and + button to the sidebar", async () => {
      await withPage(env.context, async (page) => {
        await page.goto(env.baseUrl);
        await expect(
          page.locator('.session-item input[name="id"]'),
        ).toHaveCount(2);
        await expect(page.locator("#bulk-bar")).toBeAttached();
        await expect(page.locator(".new-session-btn")).toBeVisible();
      });
    });

    it("serves the /sessions/new route pre-filling the working dir", async () => {
      const res = await authedFetch(env, "/sessions/new?working_dir=/tmp/demo");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("new-session-form");
      expect(html).toContain('name="working_dir"');
    });
  });

  describe("static assets are public (no auth required)", () => {
    it("serves the stylesheet and htmx without a session cookie", async () => {
      const css = await fetch(env.baseUrl + "/assets/app.css");
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type") ?? "").toContain("text/css");
      const htmx = await fetch(env.baseUrl + "/assets/htmx.min.js");
      expect(htmx.status).toBe(200);
      expect(htmx.headers.get("content-type") ?? "").toContain("javascript");
    });
  });

  describe("htmx partials (HX-Request)", () => {
    it("returns only the new-session fragment for the root", async () => {
      const res = await authedFetch(env, "/", {
        headers: { "HX-Request": "true" },
      });
      const html = await res.text();
      expect(html).toContain("new-session-form");
      expect(html).not.toContain(`${fx.displayName} Sessions`);
    });

    it("returns only the transcript fragment for a session", async () => {
      fx.seedMessages(env, "viewer-alpha", [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ]);
      const res = await authedFetch(
        env,
        `/sessions/${fx.viewId("viewer-alpha")}`,
        {
          headers: { "HX-Request": "true" },
        },
      );
      const html = await res.text();
      expect(html).toContain("session-header");
      expect(html).not.toContain(`${fx.displayName} Sessions`);
    });

    it("refreshes the sidebar out-of-band when ?sidebar=1 is set", async () => {
      const res = await authedFetch(
        env,
        `/sessions/${fx.viewId("viewer-alpha")}?sidebar=1`,
        {
          headers: { "HX-Request": "true" },
        },
      );
      const html = await res.text();
      expect(html).toContain('id="session-list"');
      expect(html).toContain("hx-swap-oob");
    });
  });

  describe("unknown session", () => {
    it("returns 404 with a not-found message", async () => {
      const res = await authedFetch(
        env,
        `/sessions/${fx.viewId("does-not-exist")}`,
      );
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Session not found");
    });

    it("does not shadow the /sessions/new literal route", async () => {
      const res = await authedFetch(env, "/sessions/new");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("New Session");
    });
  });
};

export { runViewerSuite };
