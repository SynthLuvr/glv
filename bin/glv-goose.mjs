#!/usr/bin/env node
// Cross-platform Node launcher, published via package.json's "bin" field.
// bin/glv-goose (POSIX shell) is retained for direct Unix invocation.
// `--import` must be given a file:// URL: on Windows a bare absolute path
// ("C:\...") is rejected by the ESM loader (ERR_UNSUPPORTED_ESM_URL_SCHEME).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = join(root, "node_modules", "tsx", "dist", "loader.mjs");
const cli = join(root, "src", "goose", "cli.ts");
const args = [
  "--import",
  pathToFileURL(tsxLoader).href,
  cli,
  ...process.argv.slice(2),
];

const { error, status } = spawnSync(process.execPath, args, {
  stdio: "inherit",
});

if (error) console.error(error);
// null status means the child was killed by a signal — surface as non-zero.
process.exitCode = error ? 1 : (status ?? 1);
