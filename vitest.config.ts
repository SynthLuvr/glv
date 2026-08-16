import { defineConfig } from "vitest/config";

const config = defineConfig({
  test: {
    include: ["src/goose/tests/**/*.test.ts"],
    // Integration tests boot a real `glv serve` subprocess and drive it with
    // a headless browser, so they need generous timeouts.
    testTimeout: 120000,
    hookTimeout: 120000,
    coverage: {
      provider: "v8",
      include: ["src/goose/**/*.ts", "src/goose/**/*.tsx"],
      exclude: ["src/goose/tests/**", "src/goose/scripts/**"],
    },
  },
});

export { config as default };
