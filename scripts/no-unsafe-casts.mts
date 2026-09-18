#!/usr/bin/env tsx
/**
 * No-unsafe-cast check: fails when product code asserts a type with `as`
 * instead of validating it (ArkType schema, typeof/instanceof guard).
 *
 *   pnpm lint:casts -> tsx scripts/no-unsafe-casts.mts
 *
 * `as const` is allowed: it narrows literal types at compile time and
 * makes no runtime claim. Test code under the tests/ directories is out
 * of scope — suites deliberately read server-owned SQLite rows and
 * response JSON through narrow casts, and the shared contract suites
 * cover those paths end to end against the running server. The rules
 * live in rules/ (listed in sgconfig.yml) so bare `ast-grep scan` and
 * editor integrations enforce the same thing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const RULES = [
  join(ROOT, "rules", "no-unsafe-cast.yml"),
  join(ROOT, "rules", "no-unsafe-cast.tsx.yml"),
];

// ts-canon bundles the ast-grep CLI, but pnpm links its dependencies
// only inside the virtual store — so resolve through ts-canon's real
// (post-symlink) location, not the repo root's node_modules.
const astGrepBinary = (): string => {
  const canonPkg = realpathSync(
    join(ROOT, "node_modules", "ts-canon", "package.json"),
  );
  const cliPkg = createRequire(canonPkg).resolve("@ast-grep/cli/package.json");
  const binary = join(dirname(cliPkg), "ast-grep");
  if (!existsSync(binary))
    throw new Error(
      `@ast-grep/cli is installed but has no binary at ${binary} — ` +
        `was the platform package (@ast-grep/cli-${process.platform}-*) skipped?`,
    );
  return binary;
};

// ast-grep takes one --rule per invocation, so the ts and tsx documents
// run as two passes over the same paths; the worse status wins.
const runRule = (binary: string, rule: string): number => {
  const result = spawnSync(binary, ["scan", "-r", rule, "src", "scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  return result.status ?? 1;
};

try {
  const binary = astGrepBinary();
  const worst = Math.max(...RULES.map((rule) => runRule(binary, rule)));
  if (worst === 0)
    console.log("no-unsafe-cast: no `as` casts in product code.");
  process.exit(worst);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
