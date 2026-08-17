#!/usr/bin/env tsx
/**
 * Cross-tree duplication check: runs jscpd over all of src/ and fails when
 * two files in DIFFERENT trees (src/goose, src/claude, src/glv) share a
 * code clone.
 *
 *   pnpm lint:cross-tree -> tsx scripts/cross-tree-duplicates.mts
 *
 * jscpd's per-tree runs (lint:duplicates) see each tree in isolation, so
 * the two product trees could drift into near-identical copies without
 * tripping it. This check closes that gap: any clone pair spanning two
 * trees fails the build unless at least one of the two files is exempt:
 *
 *   - scripts/mirrored-exemptions.json — paths still mirrored across
 *     trees, tracked by the one-location rule; shrinks as files move
 *     into src/glv and is deleted once empty.
 *   - scripts/cross-tree-exemptions.json — files with pre-existing
 *     cross-tree clone fragments (the per-flavor mock agent scripts);
 *     shrinks as those fragments are consolidated and is deleted once
 *     empty.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIRRORED_EXEMPTIONS = join(ROOT, "scripts", "mirrored-exemptions.json");
const CLONE_EXEMPTIONS = join(ROOT, "scripts", "cross-tree-exemptions.json");
const TREES = new Set(["goose", "claude", "glv"]);
// typescript + tsx mirror lint:duplicates' scope plus the .tsx views; css
// covers styles/, markdown the shared system prompt.
const FORMAT_LIST = ["typescript", "tsx", "css", "markdown"];
const FORMATS = FORMAT_LIST.join(",");

type Clone = {
  firstFile: { name: string };
  secondFile: { name: string };
  lines: number;
};

type Report = { duplicates: Clone[] };

const loadPaths = (path: string): Set<string> =>
  new Set(
    existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as string[])
      : [],
  );

// Report names are relative to the scan root (src/), e.g. "goose/db.ts",
// and may carry a ":format" suffix (e.g. "goose/system-prompt.md:markdown").
const cleanName = (scanned: string): string => {
  const [path, suffix] = scanned.split(":");
  return suffix !== undefined && FORMAT_LIST.includes(suffix) ? path : scanned;
};

const treeOf = (path: string): string | undefined => {
  const head = path.split("/")[0];
  return TREES.has(head) ? head : undefined;
};

// "goose/db.ts" -> "db.ts", the tree-relative path used by exemptions.
const withinTree = (path: string): string => path.slice(path.indexOf("/") + 1);

const runJscpd = (outDir: string): Report => {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "jscpd",
      "src",
      "--format",
      FORMATS,
      "--min-lines",
      "3",
      // Percentage thresholds are meaningless here; violations are decided
      // below from the parsed report.
      "--threshold",
      "100",
      "--reporters",
      "json",
      "--output",
      outDir,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  const reportPath = join(outDir, "jscpd-report.json");
  if (!existsSync(reportPath))
    throw new Error(
      `jscpd produced no report (status ${result.status}):\n` +
        `${result.stdout}${result.stderr}`,
    );
  return JSON.parse(readFileSync(reportPath, "utf8")) as Report;
};

const checkCrossTree = (): void => {
  const exempted = loadPaths(MIRRORED_EXEMPTIONS);
  const cloneExempted = loadPaths(CLONE_EXEMPTIONS);
  const outDir = mkdtempSync(join(tmpdir(), "glv-cross-tree-"));
  try {
    const report = runJscpd(outDir);
    const violations = report.duplicates.filter((clone) => {
      const aName = cleanName(clone.firstFile.name);
      const bName = cleanName(clone.secondFile.name);
      const a = treeOf(aName);
      const b = treeOf(bName);
      if (a === undefined || b === undefined || a === b) return false;
      return ![aName, bName].some((name) => {
        const rel = withinTree(name);
        return exempted.has(rel) || cloneExempted.has(rel);
      });
    });

    if (violations.length === 0) {
      console.log(
        `No cross-tree duplication outside the exemption lists ` +
          `(${report.duplicates.length} clone pair(s) scanned).`,
      );
      return;
    }

    const detail = violations
      .map(
        (clone) =>
          `  src/${cleanName(clone.firstFile.name)} <-> ` +
          `src/${cleanName(clone.secondFile.name)}` +
          ` (${clone.lines} duplicated lines)`,
      )
      .join("\n");
    throw new Error(
      "Cross-tree duplication found — shared code belongs once in " +
        `src/glv, never copied between flavors:\n${detail}`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
};

try {
  checkCrossTree();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
