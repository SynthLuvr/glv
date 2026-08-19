#!/usr/bin/env node
// Cross-platform Node launcher for the claude viewer, published via
// package.json's "bin" field. bin/glv-claude (POSIX shell) is retained for
// direct Unix invocation. `--import` must be given a file:// URL: on Windows
// a bare absolute path ("C:\...") is rejected by the ESM loader
// (ERR_UNSUPPORTED_ESM_URL_SCHEME).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = join(root, "node_modules", "tsx", "dist", "loader.mjs");
const cli = join(root, "src", "claude", "cli.ts");
const args = [
  "--import",
  pathToFileURL(tsxLoader).href,
  cli,
  ...process.argv.slice(2),
];

// The CLI runs as a child process, so stop signals must be forwarded to
// it — killing the launcher alone (Ctrl+C, a test harness) would orphan
// the child and everything it runs.
const child = spawn(process.execPath, args, { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("close", (status) => process.exit(status ?? 1));
