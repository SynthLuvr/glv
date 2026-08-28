import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import astV8ToIstanbul from "ast-v8-to-istanbul";
import { parseAstAsync } from "vitest/node";

// Subprocess-coverage plumbing shared by the test harness and the custom
// vitest coverage provider.
//
// glv's integration tests exercise the real `glv-goose serve` /
// `glv-claude serve` subprocesses (plus their CLIs), so vitest's
// in-process V8 coverage only ever sees the thin test wrappers — the
// product code the suite actually drives runs in child processes and
// showed up as 0%. To close that gap:
//
//   1. The harness points NODE_V8_COVERAGE at a shared raw-profile
//      directory for every spawned launcher, so Node's built-in profiler
//      writes raw script coverage for the server/CLI processes on exit.
//   2. The launcher additionally loads src/glv/tests/coverage-hook.mjs
//      (via GLV_COVERAGE_HOOK), which records the tsx-transpiled code —
//      byte-identical to what ran — together with its inline source map
//      for every module under src/.
//   3. The custom coverage provider (subprocess-coverage-provider.ts)
//      pairs raw profiles with those recorded transforms and remaps the
//      offsets onto the original sources, merging the result into
//      vitest's own coverage map.
//
// Everything is keyed off one environment variable (RAW_COVERAGE_ENV) so
// the feature is opt-in: `pnpm test` sets it through
// scripts/vitest-coverage.mts, while a bare `vitest` / `vitest run`
// behaves exactly as before.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** Env var naming the directory raw subprocess profiles land in. */
const RAW_COVERAGE_ENV = "GLV_SUBPROCESS_COVERAGE_DIR";
/** Env var naming the coverage observer the launcher must import. */
const COVERAGE_HOOK_ENV = "GLV_COVERAGE_HOOK";

const coverageHookPath = (): string =>
  join(ROOT, "src", "glv", "tests", "coverage-hook.mjs");

// Environment the harness passes to spawned launchers so their Node
// children write raw profiles and load the observer hook. Empty when the
// run was not started with propagation enabled.
const subprocessCoverageEnv = (): Record<string, string> => {
  const rawDir = process.env[RAW_COVERAGE_ENV];
  if (rawDir === undefined || rawDir === "") return {};
  return {
    NODE_V8_COVERAGE: rawDir,
    [COVERAGE_HOOK_ENV]: pathToFileURL(coverageHookPath()).href,
  };
};

type RawFunctionCoverage = {
  functionName: string;
  ranges: { startOffset: number; endOffset: number; count: number }[];
  isBlockCoverage: boolean;
};

type TransformRecord = { url: string; code: string; map: unknown };

/** Structural slice of istanbul's CoverageMap the merge needs. */
type MergeableCoverageMap = { merge: (data: unknown) => void };

type RemapSourceMap = NonNullable<
  Parameters<typeof astV8ToIstanbul>[0]["sourceMap"]
>;

const PROFILE_FILE = /^coverage-.*\.json$/;
const TRANSFORM_FILE = /^transforms-.*\.jsonl$/;

// Recorded { url, code, map } captures, first write per URL wins. Torn
// trailing lines (a crash mid-append) are skipped. Also reports the pids
// that recorded transforms: raw profiles are named coverage-<pid>-…, so
// only profiles from those pids need parsing — every other Node process
// that inherited NODE_V8_COVERAGE (mock agents, gh stubs, launcher
// shims) writes profiles too, but without a transform capture they are
// unremappable noise.
const readTransforms = (
  dir: string,
): { byUrl: Map<string, TransformRecord>; pids: Set<string> } => {
  const byUrl = new Map<string, TransformRecord>();
  const pids = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!TRANSFORM_FILE.test(name)) continue;
    pids.add(name.split("-")[1]);
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line === "") continue;
      try {
        const entry = JSON.parse(line) as TransformRecord;
        if (typeof entry.url === "string" && !byUrl.has(entry.url))
          byUrl.set(entry.url, entry);
      } catch {
        continue;
      }
    }
  }
  return { byUrl, pids };
};

// Per-URL function coverages concatenated across profile files from the
// given pids. Duplicate function entries across snapshots or server boots
// are harmless: istanbul only distinguishes hit (>0) from unhit (0), so a
// union never flips a covered statement back to uncovered.
const readRawProfiles = (
  dir: string,
  pids: Set<string>,
): Map<string, RawFunctionCoverage[]> => {
  const byUrl = new Map<string, RawFunctionCoverage[]>();
  for (const name of readdirSync(dir)) {
    if (!PROFILE_FILE.test(name)) continue;
    if (pids.size > 0 && !pids.has(name.split("-")[1])) continue;
    let parsed: {
      result?: { url: string; functions: RawFunctionCoverage[] }[];
    };
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    for (const script of parsed.result ?? []) {
      const existing = byUrl.get(script.url);
      if (existing === undefined) byUrl.set(script.url, script.functions);
      else existing.push(...script.functions);
    }
  }
  return byUrl;
};

type RemapFilter = (path: string) => boolean;

// Merges raw subprocess coverage into `coverageMap`. `isIncluded` is the
// provider's include/exclude filter, so the merge respects
// coverage.include exactly like in-process collection. URLs without a
// recorded transform (in-process worker coverage, mock-agent scripts) are
// skipped: their offsets belong to a different transform pipeline and
// vitest already handles the in-process ones itself.
const mergeSubprocessCoverage = async (
  coverageMap: MergeableCoverageMap,
  rawDir: string,
  isIncluded: RemapFilter,
): Promise<number> => {
  if (!existsSync(rawDir)) return 0;
  const { byUrl: transforms, pids } = readTransforms(rawDir);
  if (transforms.size === 0) return 0;
  const profiles = readRawProfiles(rawDir, pids);
  let merged = 0;
  for (const [url, functions] of profiles) {
    const transform = transforms.get(url);
    if (transform === undefined) continue;
    let path: string;
    try {
      path = fileURLToPath(decodeURIComponent(url));
    } catch {
      continue;
    }
    if (!existsSync(path) || !isIncluded(path)) continue;
    try {
      const data = await astV8ToIstanbul({
        code: transform.code,
        sourceMap: transform.map as RemapSourceMap,
        coverage: { url, functions },
        ast: await parseAstAsync(transform.code),
      });
      coverageMap.merge(data);
      merged += 1;
    } catch {
      // A single unparseable module must not sink the whole report.
      continue;
    }
  }
  return merged;
};

export { mergeSubprocessCoverage, RAW_COVERAGE_ENV, subprocessCoverageEnv };
