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
  // Probes headless rasterization once per run and, on hosts where the
  // headless compositor cannot produce a frame (WSL2 + recent Chrome),
  // provisions one Xvfb display that the harness's browser launches run
  // headed under — browser-facing suites otherwise hang there on
  // Playwright actionability checks. See display-global-setup.ts.
  globalSetup: ["src/glv/tests/display-global-setup.ts"],
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
  // Exception: Windows pays several times the POSIX price per spawn
  // (server + Chromium per file), and four-way file concurrency there
  // starves the runners enough to stall routine requests for whole
  // seconds — the weekly Windows run failed on exactly that (a rename
  // swap landing after a 5s assertion window, trivial handlers queueing
  // 4s+ behind concurrent servers). Two workers match the local default.
  maxWorkers:
    process.env.CI && platform() === "win32" ? 2 : process.env.CI ? 4 : 2,
  // Integration tests boot a real `glv-goose serve` / `glv-claude serve`
  // subprocess and drive it with a headless browser, so they need
  // generous timeouts.
  testTimeout: 120000,
  hookTimeout: 120000,
  coverage: {
    // The custom provider is type-a-bin's subprocess-coverage
    // companion: it extends the stock v8 provider and additionally
    // merges the raw NODE_V8_COVERAGE profiles written by the
    // server/CLI subprocesses the integration suite spawns. Enabled by
    // `pnpm test` / `pnpm test:vitest`; a bare `vitest run --coverage`
    // reports in-process coverage only, exactly like before.
    provider: "custom",
    customProviderModule: "type-a-bin/subprocess-coverage/provider",
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
    // server profiles flush, stop-path grace windows) and varies run to
    // run — observed: statements 81.2–81.3%, branches 67.5–69.5%,
    // functions 94.1–94.2%, lines 93.6–93.7%. Branches are the noisy
    // metric (race and poll outcomes flip narrow conditional arms, and
    // the subprocess-coverage merge has its own latent nondeterminism,
    // tracked upstream: SynthLuvr/type-a-bin#40), so the floors sit
    // below the observed minimums with headroom. They bind `pnpm test`
    // and any full `--coverage` run; sharded CI runs collect none.
    // Raise them as coverage improves — the point is that the number
    // is now meaningful, so regressions show up.
    thresholds: {
      statements: 40,
      branches: 25,
      functions: 36,
      lines: 50,
    },
  },
});

export { config as default };
