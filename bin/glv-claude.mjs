#!/usr/bin/env node
// Cross-platform Node launcher for the claude viewer, published via
// package.json's "bin" field. bin/glv-claude (POSIX shell) is retained
// for direct Unix invocation (it execs node, replacing the process).
// The CLI is TypeScript loaded through tsx, so the loader must
// register before it; `--import` entries accept only file:// URLs —
// on Windows a bare absolute path ("C:\...") is rejected by the ESM
// loader (ERR_UNSUPPORTED_ESM_URL_SCHEME).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxImportUrl = pathToFileURL(
  join(root, "node_modules", "tsx", "dist", "loader.mjs"),
).href;
const cli = join(root, "src", "claude", "cli.ts");
const cliArgs = process.argv.slice(2);

// Integration-test coverage: when the harness asks for it (see
// withSubprocessCoverageEnv in src/glv/tests/harness.ts), the coverage
// observer must register AFTER tsx — registerHooks chains are LIFO, so
// only the outermost hook sees tsx's transpiled output, which is what
// the raw NODE_V8_COVERAGE offsets address. An --import entry inherited
// through NODE_OPTIONS registers the observer at startup, before any
// loader imported in-process, and the hook module registers its loader
// only once — that ordering can only be undone by restarting with
// loader-then-observer on argv (node runs NODE_OPTIONS before argv
// imports, so the restarted process gets the right order and drops the
// inherited entry). With no hook in NODE_OPTIONS there is no startup
// registration to re-order: importing tsx, then the observer, then the
// CLI in this process gives the same guarantee with one node startup
// instead of two — the pattern type-a-bin 0.1.6 ships for its own
// trampoline dispatch; its hookPresentInNodeOptions decides between
// the two paths and stripCoverageHookFromNodeOptions scrubs the
// restart's inherited entry.
const coverageHook = process.env.GLV_COVERAGE_HOOK;
if (coverageHook !== undefined) {
  const { hookPresentInNodeOptions, stripCoverageHookFromNodeOptions } =
    await import("type-a-bin/subprocess-coverage");
  if (hookPresentInNodeOptions(process.env.NODE_OPTIONS ?? "")) {
    const result = spawnSync(
      process.execPath,
      ["--import", tsxImportUrl, "--import", coverageHook, cli, ...cliArgs],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_OPTIONS: stripCoverageHookFromNodeOptions(
            process.env.NODE_OPTIONS ?? "",
          ),
        },
      },
    );
    if (result.error !== undefined) {
      console.error(result.error);
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  }
}

// The CLI becomes this process's main module: argv is repositioned to
// [node, cli, ...args] so it parses exactly like a directly-run
// script, signals reach it without a forwarding wrapper, and its exit
// code is the launcher's own.
process.argv.length = 1;
process.argv.push(cli, ...cliArgs);
try {
  await import(tsxImportUrl);
  if (coverageHook !== undefined) await import(coverageHook);
  await import(pathToFileURL(cli).href);
} catch (error) {
  console.error(error);
  process.exit(1);
}
