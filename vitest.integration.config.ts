import { defineConfig } from "vitest/config";

// Integration tests boot a real `glv serve` subprocess and drive a browser.
// They are excluded from the default `pnpm test` run; run them with
// `pnpm test:integration`. Tests within a file run sequentially by default.
const config = defineConfig({
  test: {
    include: ["src/tests/**/*.integration.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});

export { config as default };
