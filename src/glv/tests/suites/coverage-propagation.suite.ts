import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { describe, it } from "vitest";
import { type FlavorFixture, withPage } from "../harness.js";
import { RAW_COVERAGE_ENV } from "../subprocess-coverage.js";

const PROFILE_FILE = /^coverage-.*\.json$/;
const TRANSFORM_FILE = /^transforms-.*\.jsonl$/;

// End-to-end check of the subprocess-coverage pipeline itself: boot a
// real server with propagation pointed at a scratch raw-profile
// directory, drive one page load over HTTP, stop the server, and verify
// the two artifact kinds the merge step depends on. Without either, the
// merged report silently loses all server-subprocess coverage.
// (Excluded on Windows — see WINDOWS_EXCLUDED_SUITES in
// vitest.config.ts — where a SIGTERM-stopped server never writes its
// profile.)
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

      assertRawProfiles(rawDir, fx.name);
      assertTransforms(rawDir);
    });
  });
};

// The server must flush a raw V8 profile on exit, and it must describe
// the code under test — the flavor's CLI entry appears as a script URL.
const assertRawProfiles = (rawDir: string, flavor: string): void => {
  const profiles = readdirSync(rawDir).filter((name) =>
    PROFILE_FILE.test(name),
  );
  expect(profiles.length).toBeGreaterThan(0);
  const mentionsCli = profiles.some((name) =>
    readFileSync(join(rawDir, name), "utf8").includes(`/src/${flavor}/cli.ts`),
  );
  expect(mentionsCli).toBe(true);
};

type RecordedTransform = {
  url: string;
  code: string;
  map: { mappings: string; sources: string[] };
};

// The observer hook must record the tsx transform of the server entry,
// with an inline source map back onto the .tsx.
const assertTransforms = (rawDir: string): void => {
  const transformFiles = readdirSync(rawDir).filter((name) =>
    TRANSFORM_FILE.test(name),
  );
  expect(transformFiles.length).toBeGreaterThan(0);
  const server = transformFiles
    .flatMap((name) => readFileSync(join(rawDir, name), "utf8").split("\n"))
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as RecordedTransform)
    .find((entry) => entry.url.endsWith("/src/glv/server/index.tsx"));
  expect(server).toBeDefined();
  expect(server?.code.length).toBeGreaterThan(1000);
  expect(server?.map.mappings.length).toBeGreaterThan(0);
  expect(server?.map.sources[0]).toContain("src/glv/server/index.tsx");
};

export { runCoveragePropagationSuite };
