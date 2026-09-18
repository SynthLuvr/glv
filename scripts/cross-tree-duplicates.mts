#!/usr/bin/env tsx
/**
 * Cross-tree duplication check: runs jscpd over all of src/ and fails when
 * two files in DIFFERENT trees (src/goose, src/claude, src/glv) share a
 * code clone.
 *
 *   pnpm lint:cross-tree -> tsx scripts/cross-tree-duplicates.mts
 *
 * The jscpd step inside `ts-canon lint` only fails when the aggregate
 * duplication rate crosses its 5% threshold, so the two product trees
 * could drift into near-identical copies without tripping it. This
 * check closes that gap: any clone pair spanning two trees fails the
 * build. The enforced floor is at least 3 lines AND 50 tokens —
 * jscpd's defaults, passed explicitly in runJscpd so the bar is
 * deliberate rather than inherited. Byte-identical copies of ANY size
 * are still caught by lint:mirrored.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import { runPnpm } from "./run-pnpm.mts";

const TREES = new Set(["goose", "claude", "glv"]);
// typescript + tsx mirror the ts-canon jscpd step's scope plus the .tsx
// views; css covers styles/, markdown the shared system prompt.
const FORMAT_LIST = ["typescript", "tsx", "css", "markdown"];
const FORMATS = FORMAT_LIST.join(",");

// The slice of jscpd's JSON report this check reads; a report missing
// these fields is a broken tool run, not an empty result, and fails
// loudly through the schema.
const Clone = type({
  firstFile: { name: "string" },
  secondFile: { name: "string" },
  lines: "number",
});

const JscpdReport = type({ duplicates: Clone.array() });

type Report = typeof JscpdReport.infer;

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

const runJscpd = (outDir: string): Report => {
  const args = [
    "exec",
    "jscpd",
    "src",
    "--format",
    FORMATS,
    "--min-lines",
    "3",
    // jscpd's default token floor, passed explicitly: it is the real
    // bar, not an accident. Below 50 tokens the matches are trivial
    // structural overlap between genuinely different adapter code
    // (parallel option lists, interface fields, test helpers) — a
    // clean tree already reports dozens of cross-tree pairs at
    // min-tokens 20, so lowering this floods the build. Byte-identical
    // copies of any size fail lint:mirrored instead.
    "--min-tokens",
    "50",
    // Percentage thresholds are meaningless here; violations are decided
    // below from the parsed report.
    "--threshold",
    "100",
    "--reporters",
    "json",
    "--output",
    outDir,
  ];
  const result = runPnpm(args);
  if (result.error) throw result.error;
  const reportPath = join(outDir, "jscpd-report.json");
  if (!existsSync(reportPath))
    throw new Error(
      `jscpd produced no report (status ${result.status}):\n` +
        `${result.stdout}${result.stderr}`,
    );
  const parsed = JscpdReport(JSON.parse(readFileSync(reportPath, "utf8")));
  if (parsed instanceof type.errors)
    throw new Error(`jscpd report failed schema validation: ${parsed.summary}`);
  return parsed;
};

const checkCrossTree = (): void => {
  const outDir = mkdtempSync(join(tmpdir(), "glv-cross-tree-"));
  try {
    const report = runJscpd(outDir);
    const violations = report.duplicates.filter((clone) => {
      const a = treeOf(cleanName(clone.firstFile.name));
      const b = treeOf(cleanName(clone.secondFile.name));
      return a !== undefined && b !== undefined && a !== b;
    });

    if (violations.length === 0) {
      console.log(
        `No cross-tree duplication ` +
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
