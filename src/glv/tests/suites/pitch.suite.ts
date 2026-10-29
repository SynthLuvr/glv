import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// GET /pitch — the public, no-auth single-page tour of glv. The auth gate
// whitelists exactly that path (auth/service.ts), so the suite pins both
// halves of the contract: the page itself renders for an anonymous
// visitor, and every other route — including /pitch subpaths — stays
// behind the passkey redirect.
const runPitchSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv;

  beforeAll(async () => {
    env = await fx.startEnv("glv-pitch-");
  }, 180000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("GET /pitch without any credential", () => {
    let html = "";

    beforeAll(async () => {
      const res = await fetch(`${env.baseUrl}/pitch`, {
        redirect: "manual",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      html = await res.text();
    });

    it("renders the pitch page, not an auth redirect", () => {
      expect(html).toContain("The self-hosted mission control");
      expect(html).not.toContain('id="passkey-button"');
    });

    it("names the served agents", () => {
      expect(html).toContain(fx.name);
    });

    it("links back to the viewer, the repo, and the shared stylesheet", () => {
      expect(html).toContain('href="/"');
      expect(html).toContain("https://github.com/SynthLuvr/glv");
      expect(html).toContain("/assets/app.css");
    });

    it("carries the hero terminal and every feature section", () => {
      expect(html).toContain("pitch-terminal");
      expect(html).toContain("glv serve");
      expect(html).toContain('id="features"');
      expect(html).toContain('id="api"');
      expect(html).toContain('id="oss"');
    });
  });

  it("serves the stylesheet the page links without auth either", async () => {
    const res = await fetch(`${env.baseUrl}/assets/app.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/css");
  });

  it("keeps the rest of the app behind the auth gate", async () => {
    const viewer = await fetch(`${env.baseUrl}/`, { redirect: "manual" });
    expect(viewer.status).toBe(302);
    expect(viewer.headers.get("location") ?? "").toContain("/auth/");

    // Exact-path exemption: /pitch subpaths are not the sales page.
    const sub = await fetch(`${env.baseUrl}/pitch/extra`, {
      redirect: "manual",
    });
    expect(sub.status).toBe(302);
    expect(sub.headers.get("location") ?? "").toContain("/auth/");
  });

  it("renders the hero and viewer links in a real browser", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(`${env.baseUrl}/pitch`);
      await expect(page.locator("h1")).toContainText(
        "The self-hosted mission control",
      );
      await expect(page.locator(".pitch-stats-grid .pitch-stat")).toHaveCount(
        6,
      );
      const viewerHref = await page
        .locator(".pitch-nav .pitch-btn")
        .getAttribute("href");
      expect(viewerHref).toBe("/");
      await expect(page.locator(".pitch-terminal")).toContainText("glv serve");
    });
  });
};

export { runPitchSuite };
