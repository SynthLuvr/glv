import { defineConfig } from "vitest/config";

const config = defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    exclude: ["src/tests/**/*.integration.test.ts"],
  },
});

export { config as default };
