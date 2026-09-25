import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { RAW_COVERAGE_ENV } from "type-a-bin/subprocess-coverage";
import { describe, it } from "vitest";
import { type FlavorFixture, withPage } from "../harness.js";

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
      const { rawDir } = await serveWithScratchCoverage(fx, "glv-covprop-");
      assertRawProfiles(rawDir);
      assertTransforms(rawDir);
    });

    it("runs the CLI in the launcher's own process", async () => {
      const { rawDir, serverPid } = await serveWithScratchCoverage(
        fx,
        "glv-covprop-pid-",
      );
      assertLauncherRanCli(rawDir, serverPid);
    });
  });
};

// Boots a real server with propagation pointed at a scratch raw-profile
// directory, drives one page load over HTTP, and stops the server so
// its profiles are flushed and ready for the caller's assertions.
const serveWithScratchCoverage = async (
  fx: FlavorFixture,
  prefix: string,
): Promise<{ rawDir: string; serverPid: number | undefined }> => {
  const rawDir = mkdtempSync(join(tmpdir(), prefix));
  const previous = process.env[RAW_COVERAGE_ENV];
  process.env[RAW_COVERAGE_ENV] = rawDir;
  const env = await fx.startEnv(prefix);
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
  return { rawDir, serverPid: env.serverPid };
};

const profileNames = (rawDir: string): string[] =>
  readdirSync(rawDir).filter((name) => PROFILE_FILE.test(name));

// The merged CLI entry must appear as a script URL in the profile —
// it is the code under test (both flavors' fixtures boot the same
// launcher, which runs src/glv/cli.ts).
const mentionsCli = (rawDir: string, names: readonly string[]): boolean =>
  names.some((name) =>
    readFileSync(join(rawDir, name), "utf8").includes("/src/glv/cli.ts"),
  );

// The server must flush a raw V8 profile on exit, and that profile
// must describe the code under test.
const assertRawProfiles = (rawDir: string): void => {
  const profiles = profileNames(rawDir);
  expect(profiles.length).toBeGreaterThan(0);
  expect(mentionsCli(rawDir, profiles)).toBe(true);
};

// The launcher loads the CLI in its own process, so the profile
// written by the spawned PID must itself mention the CLI entry — under
// a spawn-a-child launcher that PID's profile would cover only the
// .mjs wrapper.
const assertLauncherRanCli = (
  rawDir: string,
  serverPid: number | undefined,
): void => {
  expect(serverPid).toBeDefined();
  const own = profileNames(rawDir).filter((name) =>
    name.startsWith(`coverage-${serverPid}-`),
  );
  expect(own.length).toBeGreaterThan(0);
  expect(mentionsCli(rawDir, own)).toBe(true);
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
