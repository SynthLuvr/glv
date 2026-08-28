// Coverage observer for integration-test servers, loaded (--import) by
// the launchers right after tsx so this load hook runs on top of tsx's
// (hooks are LIFO). Raw NODE_V8_COVERAGE offsets point into the code
// Node actually executed — for .ts/.tsx modules that is tsx's esbuild
// output, not the source on disk — so the hook records { url, code, map }
// per module under src/: byte-identical transpiled code plus tsx's
// inline source map, which the vitest provider later uses to remap
// offsets onto the original files (see subprocess-coverage.ts).
//
// Must stay fully synchronous (registerHooks, no await): an async load
// hook breaks Node's synchronous load path (e.g. require(esm)) with
// ERR_INVALID_RETURN_PROPERTY_VALUE. Capture failures are swallowed — a
// broken observer must never take down a server under test.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC_PREFIX = pathToFileURL(join(ROOT, "src", "/")).href;
const SOURCE_MAP_MARKER = "//# sourceMappingURL=data:application/json;base64,";

const rawDir = process.env.NODE_V8_COVERAGE ?? "";
const cacheFile =
  rawDir === ""
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
    // Best-effort capture; never break the server.
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

if (cacheFile !== undefined) registerHooks({ load });
