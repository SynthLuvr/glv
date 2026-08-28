// Coverage observer for glv's integration-test servers.
//
// The integration harness boots the real `glv-goose serve` /
// `glv-claude serve` as a subprocess, so vitest's in-process V8 coverage
// never sees the server code. To fix that, the harness points Node's
// built-in profiler at a shared directory (NODE_V8_COVERAGE) so each
// server writes raw script coverage there on exit, and the launcher adds
// this module as an extra `--import` after the tsx loader.
//
// Raw V8 coverage reports offsets into the code Node actually executed.
// tsx executes an esbuild-transpiled version of every .ts/.tsx module,
// so offsets point into generated code, not the source on disk. tsx
// appends an inline base64 source map to each module it hands to Node,
// and this hook — registered after tsx, hence called on top of tsx's
// hooks — records { url, code, map } for modules under src/ into the
// coverage directory. The custom vitest coverage provider later pairs
// each raw script coverage with the recorded code+map (byte-identical to
// what ran) and remaps offsets onto the original files.
//
// The hook must stay fully synchronous (registerHooks, no await): an
// async hook breaks Node's synchronous load path (e.g. require(esm))
// with ERR_INVALID_RETURN_PROPERTY_VALUE. Capture failures are
// swallowed — a broken observer must never take down a server under
// test; it only costs coverage data.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC_PREFIX = pathToFileURL(join(ROOT, "src", "/")).href;
const SOURCE_MAP_MARKER = "//# sourceMappingURL=data:application/json;base64,";

const rawDir = process.env.NODE_V8_COVERAGE;
const cacheFile =
  rawDir === undefined || rawDir === ""
    ? undefined
    : join(
        rawDir,
        `transforms-${process.pid}-${randomBytes(4).toString("hex")}.jsonl`,
      );
const seen = new Set();

const inSrcTree = (url) =>
  typeof url === "string" && url.startsWith(SRC_PREFIX);

const extractInlineMap = (code) => {
  const at = code.lastIndexOf(SOURCE_MAP_MARKER);
  if (at === -1) return undefined;
  try {
    return JSON.parse(
      Buffer.from(code.slice(at + SOURCE_MAP_MARKER.length), "base64").toString(
        "utf8",
      ),
    );
  } catch {
    return undefined;
  }
};

const record = (url, code) => {
  const map = extractInlineMap(code);
  if (map === undefined) return;
  try {
    mkdirSync(rawDir, { recursive: true });
    appendFileSync(
      cacheFile,
      `${JSON.stringify({ url, code, map })}\n`,
      "utf8",
    );
  } catch {
    // Coverage capture is best-effort; never break the server.
  }
};

const load = (url, context, nextLoad) => {
  const result = nextLoad(url, context);
  if (
    cacheFile !== undefined &&
    !seen.has(url) &&
    inSrcTree(url) &&
    typeof result.source === "string"
  ) {
    seen.add(url);
    record(url, result.source);
  }
  return result;
};

registerHooks({ load });
