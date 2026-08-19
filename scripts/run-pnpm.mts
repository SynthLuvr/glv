import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Under a pnpm script, npm_execpath names pnpm's entry point — but it may
// be a standalone binary (ELF on Linux, .exe on Windows) that Node cannot
// load. Hand it to Node only when it is a JavaScript file, which covers
// npm-installed pnpm (a .cmd shim on Windows that spawnSync cannot
// execute); otherwise run "pnpm" off PATH, which covers everything else.
const isJsEntry = (path: string): boolean => /\.(?:c|m)?js$/u.test(path);

const runPnpm = (args: string[]): SpawnSyncReturns<string> => {
  const entry = process.env.npm_execpath;
  if (entry === undefined || !isJsEntry(entry))
    return spawnSync("pnpm", args, { cwd: ROOT, encoding: "utf8" });
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
};

export { runPnpm };
