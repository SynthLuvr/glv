import Module, { createRequire, registerHooks } from "node:module";
import { basename, extname } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";

// Preloaded (NODE_OPTIONS --import, after the tsx loader) into every Node
// process the Windows test harness touches. When the process is one of the
// harness's mock binaries — a hard link of node.exe renamed <bin>.exe — the
// "CLI entry" on its command line ("run", "pr view", ...) is not a real
// module, so this preload swaps the entry for the TypeScript mock named in
// GLV_MOCK_BIN_TARGETS, preserving argv, stdin, stdout, and exit codes.
const readTargets = () => {
  try {
    return JSON.parse(process.env.GLV_MOCK_BIN_TARGETS ?? "{}");
  } catch {
    return {};
  }
};

const name = basename(process.argv[0], extname(process.argv[0]));
const target = readTargets()[name];

// Only the shim's own main thread may redirect: tsx spawns an esbuild
// worker whose entry-point load must pass through untouched.
if (target !== undefined && threadId === 0) {
  // Node resolves the command-line entry before preloads run, so the
  // original entry ("run") is captured here and every loader below
  // redirects it to the mock script; the CLI args that followed it are
  // repositioned so the mock sees them at process.argv.slice(2).
  const originalEntry = process.argv[1];
  const cliArgs = process.argv.slice(2);
  process.argv.length = 1;
  process.argv.push(target, ...cliArgs);

  const asPath = (specifier) =>
    specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;

  // ESM main entry: resolve hooks see the main module with no parent URL,
  // so redirect that one resolution to the mock; the tsx loader (the first
  // --import in NODE_OPTIONS) resolves and transforms the .ts target.
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      if (context.parentURL == null && asPath(specifier) === originalEntry)
        return nextResolve(pathToFileURL(target).href, context);
      return nextResolve(specifier, context);
    },
  });

  // CJS main entry: Module._load receives the resolved entry with isMain
  // set — load the mock through tsx's require hooks instead.
  const origLoad = Module._load;
  Module._load = (request, parent, isMain) => {
    if (isMain && request === originalEntry) {
      Module._load = origLoad;
      createRequire(import.meta.url)("tsx/cjs");
      return origLoad(target, null, true);
    }
    return origLoad(request, parent, isMain);
  };
}
