#!/usr/bin/env tsx
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Compiles the browser client scripts from TypeScript into in-place `.js`
 * artifacts that `server.tsx` serves via `readAsset("./scripts/...")`.
 *
 *   pnpm build:scripts  ->  tsx scripts/build-scripts.mts
 *
 * Also runs automatically on `pnpm install` through the root `prepare` hook,
 * and is invoked explicitly by `setup.sh` (belt-and-suspenders for pnpm
 * versions that skip the root prepare).
 *
 * esbuild bundles (so future `import`s resolve), pins an ES2020 browser
 * target, and emits an IIFE so top-level names stay out of the global scope.
 * Identifier mangling is left off, so the served body keeps the readable
 * `updateBulkBar` name asserted by the server tests.
 */
import { build } from "esbuild";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");

await build({
  entryPoints: [resolve(root, "src/scripts/sidebar.ts")],
  outfile: resolve(root, "src/scripts/sidebar.js"),
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: false,
  sourcemap: false,
  banner: { js: "// Generated from sidebar.ts via esbuild; do not edit." },
  logLevel: "info",
});
