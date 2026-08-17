import { defineConfig } from "vitest/config";

const config = defineConfig({
  test: {
    include: ["src/goose/tests/**/*.test.ts", "src/claude/tests/**/*.test.ts"],
    // Every test file boots a real server plus a headless browser; keep
    // parallel files modest so small CI runners don't starve them.
    maxWorkers: 4,
    // Integration tests boot a real `glv serve` / `glv-claude serve`
    // subprocess and drive it with a headless browser, so they need
    // generous timeouts.
    testTimeout: 120000,
    hookTimeout: 120000,
    coverage: {
      provider: "v8",
      include: [
        "src/goose/**/*.ts",
        "src/goose/**/*.tsx",
        "src/claude/**/*.ts",
        "src/claude/**/*.tsx",
      ],
      exclude: [
        "src/goose/tests/**",
        "src/goose/scripts/**",
        "src/claude/tests/**",
        "src/claude/scripts/**",
      ],
    },
  },
});

export { config as default };
