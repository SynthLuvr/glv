#!/usr/bin/env tsx
/**
 * Pandoc lint/format check for Markdown files (GitHub-Flavored Markdown).
 *
 *   pnpm lint:md   -> tsx scripts/pandoc-md.mts --check   (read-only; exits 1 on drift)
 *   pnpm format:md -> tsx scripts/pandoc-md.mts --write   (overwrites each file)
 *
 * Every tracked `*.md` file must be byte-for-byte identical to the output of
 * `pandoc <name>.md -t gfm`, making pandoc the single source of truth for
 * Markdown formatting. Requires `pandoc` on PATH (installed in CI; see
 * .github/workflows/ci.yml and the README "Prerequisites" note).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SKIP_PARTS = new Set(["node_modules", ".git"]);

const findMarkdown = (): string[] =>
  (readdirSync(ROOT, { recursive: true }) as string[])
    .filter((p) => p.endsWith(".md"))
    .filter((p) => !p.split(sep).some((part) => SKIP_PARTS.has(part)))
    .map((p) => join(ROOT, p))
    .sort();

const pandocFormat = (file: string): string => {
  const result = spawnSync("pandoc", [file, "-t", "gfm"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error) throw result.error;

  if (result.status !== 0)
    throw new Error(
      `pandoc exited with status ${result.status}: ${result.stderr}`,
    );

  return result.stdout;
};

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  console.error("usage: tsx scripts/pandoc-md.mts --check | --write");
  process.exit(2);
}

const files = findMarkdown();
const drifted: string[] = [];

for (const file of files) {
  let formatted: string;
  try {
    formatted = pandocFormat(file);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      console.error(
        "pandoc was not found on PATH. Install pandoc (>= 3.1) and retry.",
      );
      process.exit(1);
    }
    throw error;
  }

  const rel = relative(ROOT, file);
  if (formatted === readFileSync(file, "utf8")) continue;

  if (mode === "--write") {
    writeFileSync(file, formatted);
    console.log(`formatted ${rel}`);
  } else {
    drifted.push(rel);
  }
}

if (mode === "--check") {
  if (drifted.length > 0) {
    console.error("Markdown files are not pandoc-formatted:");
    for (const f of drifted) console.error(`  ${f}`);
    console.error("\nFix with: pnpm format:md");
    process.exit(1);
  }
  console.log(`pandoc check passed for ${files.length} markdown file(s).`);
}
