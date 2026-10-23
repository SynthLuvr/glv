import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe } from "vitest";
import { runApiModelsSuite } from "../../glv/tests/suites/api-models.suite.js";
import { claudeFixture } from "./integration-harness.js";

// The claude binding of the shared /api/models suite: the static alias
// list, and the default read from the settings file under the fake home.

// The user-level settings claude itself reads; the harness's fake home
// pins CLAUDE_CONFIG_DIR at <home>/.claude, so this is exactly where
// the server's fresh-per-call read looks.
const writeClaudeSettings = (home: string): void => {
  const path = join(home, ".claude", "settings.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ model: "sonnet" }));
};

describe("api models", () =>
  runApiModelsSuite(claudeFixture, {
    prepareHome: writeClaudeSettings,
    expected: [
      {
        agent: "claude",
        label: "claude",
        default: { provider: "claude", model: "sonnet" },
        models: [
          { provider: "claude", model: "fable", label: "Fable" },
          { provider: "claude", model: "opus", label: "Opus" },
          { provider: "claude", model: "sonnet", label: "Sonnet" },
          { provider: "claude", model: "haiku", label: "Haiku" },
        ],
      },
    ],
  }));
