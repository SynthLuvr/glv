#!/usr/bin/env tsx
/**
 * Applies the canonical ast-grep rules to the .tsx view files.
 *
 *   pnpm lint:tsx   -> tsx scripts/ast-grep-tsx.mts --check
 *   pnpm format:tsx -> tsx scripts/ast-grep-tsx.mts --write
 *
 * `ts-canon lint`/`format` run the same rule ids from its bundled
 * rules with `language: TypeScript`, which ast-grep scopes to `.ts`
 * files only. The `.tsx` views under `src/glv/server/` therefore need
 * the `language: Tsx` twins in `.ast-grep/rules/` — without this step
 * they would silently escape the no-inline-export,
 * no-function-declaration, and no-file-comment rules, plus the
 * strip-braces codemod. ast-grep itself is resolved from ts-canon's
 * bundled install via its exported resolveBin, so the repo does not
 * carry a second @ast-grep/cli dependency.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBin, runCommand } from "ts-canon";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_DIR = join(ROOT, ".ast-grep", "rules");
const WRITE = process.argv.includes("--write");

/** The lint rules, in the order `ts-canon lint` runs them. */
const LINT_RULES = [
  "no-inline-export",
  "no-function-declaration",
  "no-file-comment",
] as const;

/** Runs `ast-grep scan` with a local rule over the repo's .tsx files. */
const scan = (rule: string, extraArgs: string[]): Promise<number> =>
  runCommand(
    resolveBin("@ast-grep/cli", "ast-grep"),
    [
      "scan",
      "--rule",
      join(RULES_DIR, `${rule}.yml`),
      ...extraArgs,
      "--globs",
      "*.tsx",
      ".",
    ],
    { cwd: ROOT },
  );

const main = async (): Promise<number> => {
  for (const id of LINT_RULES) {
    console.log(`> ast-grep:tsx:${id}`);
    const code = await scan(id, [`--error=${id}`]);
    if (code !== 0) return code;
  }
  if (!WRITE) return 0;
  console.log("> ast-grep:tsx:strip-braces");
  return scan("strip-braces", ["-U"]);
};

process.exit(await main());
