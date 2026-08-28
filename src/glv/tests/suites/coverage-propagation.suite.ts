import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { describe, it } from "vitest";
import { type FlavorFixture, withPage } from "../harness.js";
import { RAW_COVERAGE_ENV } from "../subprocess-coverage.js";

// End-to-end check of the subprocess-coverage pipeline itself: boot a
// real server with propagation pointed at a scratch raw-profile
// directory, drive one page load over HTTP, stop the server, and verify
// the two artifact kinds the merge step depends on — Node's raw V8
// profiles (written on process exit) and the observer hook's recorded
// tsx transforms. Without either, the merged report silently loses all
// server-subprocess coverage.
//
// Excluded on Windows (see WINDOWS_EXCLUDED_SUITES in vitest.config.ts):
// Node's kill() there is an unconditional TerminateProcess, so the
// SIGTERM-stopped server never runs its exit handlers and never writes
// its profile.
const runCoveragePropagationSuite = (fx: FlavorFixture): void => {
  describe("subprocess coverage propagation", () => {
    it("leaves remappable raw profiles and transforms for the served process", async () => {
      const rawDir = mkdtempSync(join(tmpdir(), "glv-covprop-"));
      const previous = process.env[RAW_COVERAGE_ENV];
      process.env[RAW_COVERAGE_ENV] = rawDir;
      const env = await fx.startEnv("glv-covprop-");
      try {
        await withPage(env.context, async (page) => {
          await page.goto(env.baseUrl);
          await expect(page.locator(".sidebar")).toBeVisible();
        });
      } finally {
        await env.cleanup();
        if (previous === undefined) delete process.env[RAW_COVERAGE_ENV];
        else process.env[RAW_COVERAGE_ENV] = previous;
      }

      // Raw profiles: written by the server on exit, and describing the
      // code under test (the flavor's CLI entry must appear as a URL).
      expect(existsSync(rawDir)).toBe(true);
      const names = readdirSync(rawDir);
      const profiles = names.filter((name) => /^coverage-.*\.json$/.test(name));
      expect(profiles.length).toBeGreaterThan(0);
      const sawCli = profiles.some((name) =>
        readFileSync(join(rawDir, name), "utf8").includes(
          `/src/${fx.name}/cli.ts`,
        ),
      );
      expect(sawCli).toBe(true);

      // Transforms: the observer hook's recorded tsx output for the
      // server entry, with an inline source map back onto the .tsx.
      const transforms = names.filter((name) => name.startsWith("transforms-"));
      expect(transforms.length).toBeGreaterThan(0);
      const entries = transforms.flatMap((name) =>
        readFileSync(join(rawDir, name), "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map(
            (line) =>
              JSON.parse(line) as {
                url: string;
                code: string;
                map: { mappings: string; sources: string[] };
              },
          ),
      );
      const server = entries.find((entry) =>
        entry.url.endsWith("/src/glv/server/index.tsx"),
      );
      expect(server).toBeDefined();
      expect(server?.code.length).toBeGreaterThan(1000);
      expect(server?.map.mappings.length).toBeGreaterThan(0);
      expect(server?.map.sources[0]).toContain("src/glv/server/index.tsx");
    }, 120000);
  });
};

export { runCoveragePropagationSuite };
