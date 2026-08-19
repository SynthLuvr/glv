import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// npm_execpath (set under a pnpm script) may be a standalone binary Node
// cannot load, so hand it to Node only when it is a JavaScript file — e.g.
// npm-installed pnpm, whose Windows .cmd shim spawnSync cannot execute —
// and otherwise run "pnpm" off PATH.
const isJsEntry = (path: string): boolean => /\.(?:c|m)?js$/u.test(path);

const runPnpm = (args: string[]): SpawnSyncReturns<string> => {
  const entry = process.env.npm_execpath;
  const options = { cwd: ROOT, encoding: "utf8" } as const;
  if (entry !== undefined && isJsEntry(entry))
    return spawnSync(process.execPath, [entry, ...args], options);
  return spawnSync("pnpm", args, options);
};

export { runPnpm };
