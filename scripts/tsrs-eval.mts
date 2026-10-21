#!/usr/bin/env tsx
/**
 * Type-check compiler evaluation: the Go-based `tsc` (typescript@7.0.2,
 * the `pnpm build` gate) vs the tsrs Rust port of TypeScript. Tracked
 * in docs/decisions/0010-evaluate-tsrs-rust-port.md.
 *
 *   pnpm bench:typecheck -> tsx scripts/tsrs-eval.mts
 *
 * Phases:
 *
 * 1. Benchmark: one warm-up run per compiler (discarded), then RUNS
 *    measured runs against this repo's tsconfig.json, collecting wall
 *    time, user time, and peak RSS. User time and RSS come from GNU
 *    `/usr/bin/time -v` when available and print as "-" otherwise.
 * 2. Parity: both compilers check a throwaway fixture with known type
 *    errors; diagnostics (order included) and exit codes are compared.
 *
 * Informational only — exits 0 when both compilers ran.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const RUNS = 3;
const GNU_TIME = "/usr/bin/time";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type RunStats = {
  wallMs: number;
  userMs: number | null;
  maxRssKb: number | null;
};

type PlainRun = {
  status: number;
  out: string;
};

const binPath = (name: string): string => {
  const p = join(ROOT, "node_modules", ".bin", name);
  if (!existsSync(p)) {
    console.error(`missing ${p} — run pnpm install first`);
    process.exit(1);
  }
  return p;
};

// Wraps the compiler in GNU time when present so user time and peak RSS
// come out of the same run as the wall clock. The repo type-checks
// clean today; a nonzero status here means the tree itself is broken,
// which would make the benchmark meaningless, so the harness stops.
const measureRun = (bin: string): RunStats => {
  const useGnuTime = existsSync(GNU_TIME);
  const file = useGnuTime ? GNU_TIME : bin;
  const args = useGnuTime ? ["-v", bin] : [];
  const start = performance.now();
  const result = spawnSync(file, args, { encoding: "utf8" });
  const wallMs = performance.now() - start;
  if (result.error || result.status !== 0) {
    console.error(
      `${bin} did not type-check cleanly (status ${result.status ?? "signal"}) — fix the tree before benchmarking`,
    );
    process.exit(1);
  }
  const stderr = result.stderr ?? "";
  const user = stderr.match(/User time \(seconds\): ([\d.]+)/);
  const rss = stderr.match(/Maximum resident set size \(kbytes\): ([\d.]+)/);
  return {
    wallMs,
    userMs: user ? Number(user[1]) * 1000 : null,
    maxRssKb: rss ? Number(rss[1]) : null,
  };
};

const runPlain = (bin: string, args: string[]): PlainRun => {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  return {
    status: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

const sample = (bin: string): RunStats[] => {
  measureRun(bin); // warm-up, discarded
  const runs: RunStats[] = [];
  for (let i = 0; i < RUNS; i++) runs.push(measureRun(bin));
  return runs;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const med = (
  runs: RunStats[],
  pick: (r: RunStats) => number | null,
): number | null => {
  const values = runs.map(pick).filter((v): v is number => v !== null);
  return values.length === runs.length ? median(values) : null;
};

const fmtSec = (v: number | null): string =>
  v === null ? "-" : `${(v / 1000).toFixed(2)}s`;

const fmtRss = (v: number | null): string =>
  v === null ? "-" : `${Math.round(v / 1024)} MB`;

const firstLine = (s: string): string => s.split("\n")[0]?.trim() ?? "";

const fmtPct = (part: number, whole: number): string =>
  `${(100 * (1 - part / whole)).toFixed(0)}%`;

// A small multi-file fixture whose four errors span two files: parity
// here also compares the order diagnostics are printed in, which the
// tsrs README/blog call out as not yet guaranteed to match upstream.
const FIXTURE: Record<string, string> = {
  "a.ts": [`const x: number = "oops";`, `const y: string = 42;`, ""].join("\n"),
  "b.ts": [
    `const p: Promise<number> = new Promise<string>((resolve) =>`,
    `  resolve("x"));`,
    `const q = p + 1;`,
    "",
  ].join("\n"),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2025",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2025"],
        types: [],
      },
      files: ["a.ts", "b.ts"],
    },
    null,
    2,
  ),
};

const parityCheck = (tscBin: string, tsrsBin: string): void => {
  const dir = mkdtempSync(join(tmpdir(), "tsrs-eval-"));
  try {
    for (const [name, content] of Object.entries(FIXTURE))
      writeFileSync(join(dir, name), content);
    const tsc = runPlain(tscBin, ["-p", dir, "--pretty", "false"]);
    const tsrs = runPlain(tsrsBin, ["-p", dir, "--pretty", "false"]);
    const identical = tsc.out === tsrs.out;
    console.log(
      `diagnostics parity (4-error fixture): ${identical ? "identical" : "DIFFERS"}`,
    );
    console.log(`exit codes on errors: tsc=${tsc.status}, tsrs=${tsrs.status}`);
    if (!identical) {
      console.log("--- tsc ---");
      console.log(tsc.out.trimEnd());
      console.log("--- tsrs ---");
      console.log(tsrs.out.trimEnd());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const tscBin = binPath("tsc");
const tsrsBin = binPath("tsrs");

console.log(`type-check evaluation: ${RUNS} measured runs after 1 warm-up`);
console.log(`  tsc : ${firstLine(runPlain(tscBin, ["--version"]).out)}`);
console.log(`  tsrs: ${firstLine(runPlain(tsrsBin, ["--version"]).out)}`);

const tscRuns = sample(tscBin);
const tsrsRuns = sample(tsrsBin);

const row = (label: string, runs: RunStats[]): string =>
  [
    `  ${label}`.padEnd(34),
    fmtSec(med(runs, (r) => r.wallMs)).padStart(7),
    fmtSec(med(runs, (r) => r.userMs)).padStart(8),
    fmtRss(med(runs, (r) => r.maxRssKb)).padStart(9),
  ].join("  ");

console.log("\n  compiler                            wall     user    maxRSS");
console.log(`  (${RUNS} runs, repo tsconfig, medians)`);
console.log(row("tsc  (typescript@7.0.2, Go)", tscRuns));
console.log(row("tsrs (Rust port)", tsrsRuns));

const tscWall = med(tscRuns, (r) => r.wallMs);
const tsrsWall = med(tsrsRuns, (r) => r.wallMs);
const tscUser = med(tscRuns, (r) => r.userMs);
const tsrsUser = med(tsrsRuns, (r) => r.userMs);
const tscRss = med(tscRuns, (r) => r.maxRssKb);
const tsrsRss = med(tsrsRuns, (r) => r.maxRssKb);

if (tscWall !== null && tsrsWall !== null && tsrsWall > 0) {
  console.log(
    `\n  tsrs vs tsc: ${(tscWall / tsrsWall).toFixed(1)}x faster wall`,
  );
  if (tscUser !== null && tsrsUser !== null && tsrsUser > 0)
    console.log(`  user time: ${fmtPct(tsrsUser, tscUser)} less`);
  if (tscRss !== null && tsrsRss !== null && tsrsRss > 0)
    console.log(`  peak RSS:  ${fmtPct(tsrsRss, tscRss)} less`);
}

parityCheck(tscBin, tsrsBin);
