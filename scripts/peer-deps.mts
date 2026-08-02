#!/usr/bin/env tsx
/**
 * Fails `pnpm lint` when the installed tree has unmet or missing peer
 * dependencies.
 *
 *   pnpm lint:peer-deps -> tsx scripts/peer-deps.mts
 *
 * Uses `pnpm peers check` (which inspects the lockfile directly) rather than
 * `install --strict-peer-dependencies`: a frozen lockfile is not re-resolved
 * during install, so the strict flag silently misses pre-existing peer
 * conflicts.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const checkPeerDependencies = (): void => {
  const result = spawnSync("pnpm", ["peers", "check"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (result.error) throw result.error;

  if (result.status === 0) {
    console.log("No peer dependency issues found.");
    return;
  }

  const detail = `${result.stdout}${result.stderr}`.trim();
  throw new Error(
    `Peer dependency issues found after \`pnpm install\`.` +
      `${detail ? `\n\n${detail}\n` : ""}` +
      "\nResolve the conflicts above, then re-run `pnpm install`.",
  );
};

try {
  checkPeerDependencies();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
