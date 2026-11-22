import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type FlavorFixture,
  type IntegrationEnv,
  withPage,
} from "../harness.js";

// The asset-serving contract, exercised over real HTTP against a real
// serve boot. This suite is the regression proof for the
// session-viewer-renders-unstyled-on-phones bug (report behind #409's
// wrong diagnosis). Two failure halves, two stories:
//
// 1. Revalidation. Every /assets response carries a strong ETag and
//    Cache-Control: no-cache, so a browser stores the body but must
//    confirm before reuse: unchanged content answers 304 — across
//    restarts, so a phone returning after minutes revalidates against
//    whatever server is up now — and changed content answers 200 on
//    the same URL. This is what keeps one bad response from pinning a
//    broken (or merely stale) stylesheet into a browser for as long as
//    the old public, max-age=86400 blind freshness window lasted.
//
// 2. Serve-never-ship-broken. A build killed mid-write leaves a
//    truncated output file beside a manifest from the last successful
//    build — fingerprint unchanged, sources unchanged — which the
//    up-to-date gate used to accept on existence alone, serving an
//    empty stylesheet to every boot afterwards. Truncating the real
//    dist output here and restarting must make the next boot rebuild,
//    and a real browser loading the page must end up styled.

// The merged CLI always reads assets from dist/glv, whichever flavor
// fixture boots it (src/glv/cli.ts passes assetsFlavor: "glv").
const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const productCssPath = join(repoRoot, "dist", "glv", "app.css");

const runAssetCacheSuite = (fx: FlavorFixture): void => {
  let env: IntegrationEnv | undefined;

  const getCss = (init: RequestInit = {}): Promise<Response> =>
    fetch(`${env?.baseUrl}/assets/app.css`, init);

  beforeAll(async () => {
    env = await fx.startEnv("glv-asset-cache-");
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("revalidation contract", () => {
    it("serves the stylesheet with an etag and no-cache", async () => {
      const res = await getCss();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/css");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const etag = res.headers.get("etag");
      expect(etag ?? "").toMatch(/^"[0-9a-f]{64}"$/);
      expect((await res.text()).length).toBeGreaterThan(1000);
    });

    it("answers 304 for a matching etag, weak or plain", async () => {
      const first = await getCss();
      const etag = first.headers.get("etag") ?? "";
      expect(etag).not.toBe("");

      const plain = await getCss({ headers: { "if-none-match": etag } });
      expect(plain.status).toBe(304);
      expect((await plain.arrayBuffer()).byteLength).toBe(0);

      const weak = await getCss({
        headers: { "if-none-match": `W/${etag}` },
      });
      expect(weak.status).toBe(304);
    });

    it("answers 304 for a wildcard if-none-match", async () => {
      const res = await getCss({ headers: { "if-none-match": "*" } });
      expect(res.status).toBe(304);
    });

    it("serves the full body when the etag differs", async () => {
      const res = await getCss({
        headers: { "if-none-match": '"deadbeef"' },
      });
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBeGreaterThan(1000);
    });

    // The phone's actual return trip: a stored copy revalidates against
    // whatever server instance is now behind the URL. Same content must
    // answer 304 even though the process — and its asset bundle — is
    // brand new, so a returning client never refetches blindly and a
    // healed server is picked up on the next load, not a day later.
    it("a matching etag survives a restart", async () => {
      const first = await getCss();
      const etag = first.headers.get("etag") ?? "";
      expect(etag).not.toBe("");

      await env?.restart();

      const revalidated = await getCss({
        headers: { "if-none-match": etag },
      });
      expect(revalidated.status).toBe(304);
    });

    it("applies the same contract to the other assets", async () => {
      const res = await fetch(`${env?.baseUrl}/assets/htmx.min.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("etag") ?? "").toMatch(/^"[0-9a-f]{64}"$/);
    });
  });

  describe("a build interrupted mid-write is never served", () => {
    it("rebuilds on boot when a dist output is truncated", async () => {
      const healthy = statSync(productCssPath).size;
      expect(healthy).toBeGreaterThan(1000);
      // The end state of any killed build: an empty output file beside a
      // manifest whose fingerprint still matches the unchanged sources.
      writeFileSync(productCssPath, "");

      // The harness restarts serve on a fresh port; the boot's
      // up-to-date gate now sees the empty output and rebuilds.
      await env?.restart();

      const res = await getCss();
      expect(res.status).toBe(200);
      const css = await res.text();
      expect(css.length).toBeGreaterThan(1000);
      expect(statSync(productCssPath).size).toBe(Buffer.byteLength(css));
    });

    it("renders a styled page from the rebuilt assets", async () => {
      const e = env;
      if (e === undefined) throw new Error("environment not started");
      await withPage(e.context, async (page) => {
        await page.goto(e.baseUrl);
        await page.waitForLoadState("networkidle");
        const font = await page.evaluate(
          () => getComputedStyle(document.body).fontFamily,
        );
        // Unstyled pages fall back to the UA serif; the stylesheet's
        // body rule sets the system-ui stack.
        expect(font).toContain("system-ui");
      });
      // Leave the real dist healthy for whatever runs next.
      expect(statSync(productCssPath).size).toBeGreaterThan(1000);
      expect(readFileSync(productCssPath, "utf8")).toContain("tailwindcss");
    });
  });
};

export { runAssetCacheSuite };
