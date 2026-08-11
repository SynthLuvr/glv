#!/usr/bin/env node
// Cross-platform Node launcher for the glv CLI. Mirrors bin/glv (the POSIX
// shell launcher) but runs on Windows too: it is the canonical entry point
// published via package.json's "bin" field and used by global installs.
// bin/glv is retained for direct Unix invocation (the test harness spawns it).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = join(root, "node_modules", "tsx", "dist", "loader.mjs");
const cli = join(root, "src", "cli.ts");
const args = ["--import", tsxLoader, cli, ...process.argv.slice(2)];

const result = spawnSync(process.execPath, args, { stdio: "inherit" });

// Forward the child's exit status; surface a spawn failure as non-zero.
if (result.error) {
  console.error(result.error);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
