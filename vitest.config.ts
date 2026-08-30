import { platform } from "node:os";
import { vitestPreset } from "ts-canon/presets/vitest";
import { configDefaults } from "vitest/config";

// The coverage-propagation suites cannot run on Windows: kill() there is
// an unconditional TerminateProcess (libuv delivers no signal events), so
// a SIGTERM-stopped server never runs its exit handlers and never flushes
// its NODE_V8_COVERAGE profile — the artifacts the suite asserts cannot
// exist. Subprocess coverage for serve processes is therefore POSIX-only
// for now; normally-exiting CLI invocations still flush and merge there.
const WINDOWS_EXCLUDED_SUITES = [
  "src/goose/tests/coverage-propagation.integration.test.ts",
  "src/claude/tests/coverage-propagation.integration.test.ts",
];

// The canonical shape (v8 coverage, thresholds, src/tests layout) comes
// from ts-canon's vitest preset; everything below is repo-specific and
// replaces the preset defaults wholesale.
const config = vitestPreset({
  include: [
    "src/glv/tests/**/*.test.ts",
    "src/goose/tests/**/*.test.ts",
    "src/claude/tests/**/*.test.ts",
  ],
  exclude:
    platform() === "win32"
      ? [...configDefaults.exclude, ...WINDOWS_EXCLUDED_SUITES]
      : configDefaults.exclude,
  // Every test file boots a real server plus a headless browser, so each
  // concurrent file costs several hundred MB. CI runners have dedicated
  // vCPUs and no competing dev load, so they can safely run more files at
  // once; locally two workers keep the peak low alongside normal load.
  maxWorkers: process.env.CI ? 4 : 2,
  // Integration tests boot a real `glv-goose serve` / `glv-claude serve`
  // subprocess and drive it with a headless browser, so they need
  // generous timeouts.
  testTimeout: 120000,
  hookTimeout: 120000,
  coverage: {
    // The custom provider extends the stock v8 one and additionally
    // merges the raw NODE_V8_COVERAGE profiles written by the
    // server/CLI subprocesses the integration suite spawns (see
    // src/glv/tests/subprocess-coverage.ts). Enabled by `pnpm test` /
    // `pnpm test:vitest`; a bare `vitest run --coverage` reports
    // in-process coverage only, exactly like before.
    provider: "custom",
    customProviderModule: "./src/glv/tests/subprocess-coverage-provider.ts",
    include: [
      "src/glv/**/*.ts",
      "src/goose/**/*.ts",
      "src/glv/**/*.tsx",
      "src/goose/**/*.tsx",
      "src/claude/**/*.ts",
      "src/claude/**/*.tsx",
    ],
    exclude: [
      "src/glv/tests/**",
      "src/goose/tests/**",
      "src/glv/scripts/**",
      "src/goose/scripts/**",
      "src/claude/tests/**",
      "src/claude/scripts/**",
    ],
    // Floors for the merged report, which is timing-sensitive (which
    // server profiles flush, stop-path grace windows) and varies run
    // to run — observed: statements 43.0–46.8%, branches 27.2–33.5%,
    // functions 38.1–47.0%, lines 52.2–56.9%. The floors sit below
    // the observed minimums with headroom; they bind `pnpm test` (and
    // any full `--coverage` run), while sharded CI runs don't collect
    // coverage. Raise them as coverage improves — the point is that
    // the number is now meaningful, so regressions show up.
    thresholds: {
      statements: 40,
      branches: 25,
      functions: 36,
      lines: 50,
    },
  },
});

export { config as default };
