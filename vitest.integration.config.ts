import { defineConfig } from "vitest/config";

// Integration tests boot a real `glv serve` subprocess and drive a browser.
// Excluded from the default `pnpm test` run — use `pnpm test:integration`.
const config = defineConfig({
  test: {
    include: ["src/tests/**/*.integration.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});

export { config as default };
