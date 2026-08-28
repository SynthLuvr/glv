#!/usr/bin/env tsx
/**
 * Runs vitest with subprocess coverage propagation enabled.
 *
 *   pnpm test:vitest -> tsx scripts/vitest-coverage.mts run --coverage
 *
 * `vitest run --coverage` on its own only reports code executed by the
 * in-process test workers — the real `glv-goose serve` / `glv-claude
 * serve` subprocesses the integration suite drives are invisible to it,
 * which used to make a comprehensive suite report ~8%. This wrapper sets
 * GLV_SUBPROCESS_COVERAGE_DIR so the test harness points each spawned
 * launcher's NODE_V8_COVERAGE at a shared raw-profile directory and
 * loads the coverage observer hook (see src/glv/tests/subprocess-
 * coverage.ts for the full pipeline). The custom coverage provider
 * configured in vitest.config.ts merges those raw profiles into the
 * final report. A bare `vitest` / `vitest run` without this wrapper
 * behaves exactly as before.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntry = join(ROOT, "node_modules", "vitest", "vitest.mjs");

const result = spawnSync(
  process.execPath,
  [vitestEntry, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      GLV_SUBPROCESS_COVERAGE_DIR: join(ROOT, "coverage", ".v8-raw"),
    },
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
