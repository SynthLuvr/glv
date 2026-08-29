import { platform } from "node:os";
import { vitestPreset } from "ts-canon/presets/vitest";
import { configDefaults } from "vitest/config";

// Two categories of suites cannot run on Windows yet.
//
// 1. The claude-flavored suites that spawn the (mocked) agent binary:
//    PATH interception there needs a real .exe (Node refuses to spawn
//    .cmd/.bat shims without a shell), and both available hosting
//    tricks fail for claude's flag-first CLI: a hard-linked node.exe
//    dies in Node's option parser before any preload can run ("bad
//    option: --session-id") — the goose flavor works only because its
//    first argument is a positional ("run"; see type-a-bin's Windows
//    support) — and a .cmd shim cannot carry claude's multi-line
//    --append-system-prompt argument (execa rejects line breaks to
//    prevent cmd.exe injection). Until a real passthrough .exe ships,
//    these suites are excluded on Windows here; the same suites still
//    run there through the goose flavor, which drives the identical
//    glv core.
//
// 2. The coverage-propagation suites: Node's kill() on Windows is an
//    unconditional TerminateProcess (libuv delivers no signal events),
//    so a SIGTERM-stopped server never runs its exit handlers and never
//    flushes its NODE_V8_COVERAGE profile — the artifacts the suite
//    asserts cannot exist there. Subprocess coverage for serve
//    processes is therefore POSIX-only for now (normally-exiting CLI
//    invocations still flush and merge on Windows).
const WINDOWS_EXCLUDED_SUITES = [
  "src/claude/tests/archive-stops-run.integration.test.ts",
  "src/claude/tests/dir-spelling.integration.test.ts",
  "src/claude/tests/follow-up-upload.integration.test.ts",
  "src/claude/tests/git-pull-before-session.integration.test.ts",
  "src/claude/tests/group-running-indicator.integration.test.ts",
  "src/claude/tests/mobile-upload-start.integration.test.ts",
  "src/claude/tests/new-session.integration.test.ts",
  "src/claude/tests/sessions-routes.integration.test.ts",
  "src/claude/tests/runner-stream.integration.test.ts",
  "src/claude/tests/sandboxed-env.integration.test.ts",
  "src/claude/tests/status-feed.integration.test.ts",
  "src/claude/tests/stop-escalation.integration.test.ts",
  "src/claude/tests/stop-kills-descendants.integration.test.ts",
  "src/claude/tests/stream-discard-non-json.integration.test.ts",
  "src/claude/tests/stream-live.integration.test.ts",
  "src/claude/tests/stream-preview-live.integration.test.ts",
  "src/claude/tests/system-flag.integration.test.ts",
  "src/claude/tests/temp-dir.integration.test.ts",
  "src/claude/tests/upload.integration.test.ts",
  "src/claude/tests/ux-audit.integration.test.ts",
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
