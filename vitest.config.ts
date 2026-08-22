import { platform } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

// The claude-flavored suites that spawn the (mocked) agent binary cannot
// run on Windows yet. PATH interception there needs a real .exe (Node
// refuses to spawn .cmd/.bat shims without a shell), and both available
// hosting tricks fail for claude's flag-first CLI: a hard-linked node.exe
// dies in Node's option parser before any preload can run ("bad option:
// --session-id") — the goose flavor works only because its first argument
// is a positional ("run"; see type-a-bin's Windows support) — and a .cmd
// shim cannot carry claude's multi-line --append-system-prompt argument
// (execa rejects line breaks to prevent cmd.exe injection). Until a real
// passthrough .exe ships, these suites are excluded on Windows here; the
// same suites still run there through the goose flavor, which drives the
// identical glv core.
const CLAUDE_AGENT_SPAWN_SUITES = [
  "src/claude/tests/dir-spelling.integration.test.ts",
  "src/claude/tests/follow-up-upload.integration.test.ts",
  "src/claude/tests/git-pull-before-session.integration.test.ts",
  "src/claude/tests/group-running-indicator.integration.test.ts",
  "src/claude/tests/mobile-upload-start.integration.test.ts",
  "src/claude/tests/new-session.integration.test.ts",
  "src/claude/tests/runner-stream.integration.test.ts",
  "src/claude/tests/sandboxed-env.integration.test.ts",
  "src/claude/tests/status-feed.integration.test.ts",
  "src/claude/tests/stop-kills-descendants.integration.test.ts",
  "src/claude/tests/stream-discard-non-json.integration.test.ts",
  "src/claude/tests/stream-live.integration.test.ts",
  "src/claude/tests/stream-preview-live.integration.test.ts",
  "src/claude/tests/system-flag.integration.test.ts",
  "src/claude/tests/temp-dir.integration.test.ts",
  "src/claude/tests/upload.integration.test.ts",
  "src/claude/tests/ux-audit.integration.test.ts",
];

const config = defineConfig({
  test: {
    include: [
      "src/glv/tests/**/*.test.ts",
      "src/goose/tests/**/*.test.ts",
      "src/claude/tests/**/*.test.ts",
    ],
    exclude:
      platform() === "win32"
        ? [...configDefaults.exclude, ...CLAUDE_AGENT_SPAWN_SUITES]
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
      provider: "v8",
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
    },
  },
});

export { config as default };
