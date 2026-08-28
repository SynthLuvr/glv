#!/usr/bin/env node
// Cross-platform Node launcher, published via package.json's "bin" field.
// bin/glv-goose (POSIX shell) is retained for direct Unix invocation.
// `--import` must be given a file:// URL: on Windows a bare absolute path
// ("C:\...") is rejected by the ESM loader (ERR_UNSUPPORTED_ESM_URL_SCHEME).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = join(root, "node_modules", "tsx", "dist", "loader.mjs");
const cli = join(root, "src", "goose", "cli.ts");
// Integration-test coverage: when the harness asks for it, load the
// coverage observer right after tsx. Order matters — the observer must
// see tsx's transpiled output, so it registers its hook after tsx's.
const coverageHook = process.env.GLV_COVERAGE_HOOK;
const args = [
  "--import",
  pathToFileURL(tsxLoader).href,
  ...(coverageHook === undefined ? [] : ["--import", coverageHook]),
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
