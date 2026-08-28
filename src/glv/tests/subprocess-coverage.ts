import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import astV8ToIstanbul from "ast-v8-to-istanbul";
import { parseAstAsync } from "vitest/node";

// Subprocess-coverage plumbing shared by the test harness and the custom
// vitest coverage provider (subprocess-coverage-provider.ts).
//
// The integration suite drives the real `glv-goose serve` /
// `glv-claude serve` subprocesses (plus their CLIs), which vitest's
// in-process V8 coverage never sees — the product code used to report as
// 0% despite being comprehensively exercised. When RAW_COVERAGE_ENV
// names a directory (set by scripts/vitest-coverage.mts behind
// `pnpm test`):
//
//   1. The harness points each spawned launcher's NODE_V8_COVERAGE at
//      that directory, so Node's built-in profiler writes raw script
//      coverage for the server/CLI processes on exit.
//   2. The launcher also loads src/glv/tests/coverage-hook.mjs, which
//      records the tsx-transpiled code — byte-identical to what ran —
//      together with its inline source map for every module under src/.
//   3. The provider pairs raw profiles with those transforms, remaps
//      the offsets onto the original sources, and merges the result
//      into vitest's coverage map.
//
// Without the env var (a bare `vitest run`), propagation is off and
// everything behaves exactly as before.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const RAW_COVERAGE_ENV = "GLV_SUBPROCESS_COVERAGE_DIR";
const COVERAGE_HOOK_ENV = "GLV_COVERAGE_HOOK";
const COVERAGE_HOOK_PATH = join(
  ROOT,
  "src",
  "glv",
  "tests",
  "coverage-hook.mjs",
);

// The raw-profile directory for this run, or undefined when
// propagation is off.
const rawCoverageDir = (): string | undefined => {
  const dir = process.env[RAW_COVERAGE_ENV];
  return dir === undefined || dir === "" ? undefined : dir;
};

// Environment the harness passes to spawned launchers so their Node
// children write raw profiles and load the observer hook.
const subprocessCoverageEnv = (): Record<string, string> => {
  const rawDir = rawCoverageDir();
  return rawDir === undefined
    ? {}
    : {
        NODE_V8_COVERAGE: rawDir,
        [COVERAGE_HOOK_ENV]: pathToFileURL(COVERAGE_HOOK_PATH).href,
      };
};

type RawFunctionCoverage = {
  functionName: string;
  ranges: { startOffset: number; endOffset: number; count: number }[];
  isBlockCoverage: boolean;
};

type RawScriptCoverage = { url: string; functions: RawFunctionCoverage[] };

type TransformRecord = { url: string; code: string; map: unknown };

/** Structural slice of istanbul's CoverageMap that the merge needs. */
type MergeableCoverageMap = { merge: (data: unknown) => void };

type RemapSourceMap = NonNullable<
  Parameters<typeof astV8ToIstanbul>[0]["sourceMap"]
>;

type RemapFilter = (path: string) => boolean;

const PROFILE_FILE = /^coverage-.*\.json$/;
const TRANSFORM_FILE = /^transforms-.*\.jsonl$/;

// Profile and transform file names are <kind>-<pid>-<suffix>.
const pidOf = (fileName: string): string => fileName.split("-")[1];

// One recorded module per line; a torn trailing line (crash mid-append)
// is skipped.
const readTransformLines = (file: string): TransformRecord[] => {
  const records: TransformRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    try {
      records.push(JSON.parse(line) as TransformRecord);
    } catch {
      continue;
    }
  }
  return records.filter((record) => typeof record.url === "string");
};

// Transforms recorded by coverage-hook.mjs; the first record per URL
// wins. Also reports the pids that recorded transforms: raw profiles
// are named coverage-<pid>-…, and only those pids' profiles are
// remappable — every other Node process that inherited
// NODE_V8_COVERAGE (mock agents, gh stubs, launcher shims) writes
// profiles too, but without a transform they are noise.
const readTransforms = (
  dir: string,
): { byUrl: Map<string, TransformRecord>; pids: Set<string> } => {
  const files = readdirSync(dir).filter((name) => TRANSFORM_FILE.test(name));
  const byUrl = new Map<string, TransformRecord>();
  for (const name of files)
    for (const record of readTransformLines(join(dir, name)))
      if (!byUrl.has(record.url)) byUrl.set(record.url, record);
  return { byUrl, pids: new Set(files.map(pidOf)) };
};

// A raw profile file Node writes on process exit; unparseable files
// read as empty.
const readProfileScripts = (file: string): RawScriptCoverage[] => {
  try {
    const parsed: { result?: RawScriptCoverage[] } = JSON.parse(
      readFileSync(file, "utf8"),
    );
    return parsed.result ?? [];
  } catch {
    return [];
  }
};

// Per-URL function coverages concatenated across the profile files of
// the given pids. Duplicate entries across snapshots or server boots
// are harmless: istanbul only distinguishes hit (>0) from unhit (0), so
// a union never flips a covered statement back to uncovered.
const readRawProfiles = (
  dir: string,
  pids: Set<string>,
): Map<string, RawFunctionCoverage[]> => {
  const remappable = (name: string): boolean =>
    PROFILE_FILE.test(name) && (pids.size === 0 || pids.has(pidOf(name)));
  const byUrl = new Map<string, RawFunctionCoverage[]>();
  for (const name of readdirSync(dir).filter(remappable))
    for (const script of readProfileScripts(join(dir, name)))
      byUrl.set(script.url, [
        ...(byUrl.get(script.url) ?? []),
        ...script.functions,
      ]);
  return byUrl;
};

// Remaps one script's raw offsets onto the original source through the
// recorded transform. Undefined when the script is out of scope or
// unremappable — a single bad module must not sink the whole report.
const remapScript = async (
  url: string,
  functions: RawFunctionCoverage[],
  transform: TransformRecord,
  isIncluded: RemapFilter,
) => {
  let path: string;
  try {
    path = fileURLToPath(decodeURIComponent(url));
  } catch {
    return undefined;
  }
  if (!existsSync(path) || !isIncluded(path)) return undefined;
  try {
    return await astV8ToIstanbul({
      code: transform.code,
      sourceMap: transform.map as RemapSourceMap,
      coverage: { url, functions },
      ast: await parseAstAsync(transform.code),
    });
  } catch {
    return undefined;
  }
};

// Merges raw subprocess coverage into `coverageMap`. `isIncluded` is
// the provider's include/exclude filter, so the merge respects
// coverage.include exactly like in-process collection. URLs without a
// recorded transform (in-process worker coverage, mock-agent scripts)
// are skipped: their offsets belong to a different transform pipeline,
// and vitest already handles the in-process ones itself.
const mergeSubprocessCoverage = async (
  coverageMap: MergeableCoverageMap,
  rawDir: string,
  isIncluded: RemapFilter,
): Promise<number> => {
  if (!existsSync(rawDir)) return 0;
  const { byUrl: transforms, pids } = readTransforms(rawDir);
  if (transforms.size === 0) return 0;
  let merged = 0;
  for (const [url, functions] of readRawProfiles(rawDir, pids)) {
    const transform = transforms.get(url);
    if (transform === undefined) continue;
    const data = await remapScript(url, functions, transform, isIncluded);
    if (data === undefined) continue;
    coverageMap.merge(data);
    merged += 1;
  }
  return merged;
};

export type { MergeableCoverageMap };
export {
  mergeSubprocessCoverage,
  RAW_COVERAGE_ENV,
  rawCoverageDir,
  subprocessCoverageEnv,
};
