import { defineConfig } from "vitest/config";

const config = defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    // Integration tests boot a real `glv serve` subprocess and drive it with
    // a headless browser, so they need generous timeouts.
    testTimeout: 120000,
    hookTimeout: 120000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/tests/**", "src/scripts/**"],
    },
  },
});

export { config as default };
