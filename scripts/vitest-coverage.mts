#!/usr/bin/env tsx
// Runs vitest with subprocess coverage propagation enabled
// (`pnpm test:vitest`). The env var below makes the test harness point
// each spawned launcher's NODE_V8_COVERAGE at a shared raw-profile
// directory, which the custom coverage provider configured in
// vitest.config.ts merges into the report (see
// src/glv/tests/subprocess-coverage.ts). A bare `vitest run` without
// this wrapper behaves exactly as before.
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
