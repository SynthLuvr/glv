import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { buildSync } from "esbuild";
import { execaSync } from "execa";

const GLV_SRC = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(GLV_SRC, "..", "..");

// node_modules/.bin holds POSIX shell shims that Node cannot spawn on
// Windows, so invoke the Tailwind CLI's real JavaScript entry with the
// current Node executable — identical behavior on every platform.
const nodeRequire = createRequire(import.meta.url);
const TAILWIND_ENTRY = join(
  dirname(nodeRequire.resolve("@tailwindcss/cli/package.json")),
  "dist",
  "index.mjs",
);

// Bundle every client entry into a self-contained IIFE in one pass, so any
// script may import shared modules (e.g. ./shared) without bespoke config.
const CLIENT_ENTRY_NAMES = [
  "sidebar",
  "stream",
  "rename",
  "actions",
  "ui",
  "groups",
  "prompts",
  "passkey",
  "uploads",
  "location",
  "schedule",
];

const CLIENT_ENTRIES = CLIENT_ENTRY_NAMES.map((name) =>
  join(GLV_SRC, "scripts", `${name}.ts`),
);

const OUTPUT_FILES = [
  "app.css",
  ...CLIENT_ENTRY_NAMES.map((name) => `${name}.js`),
];

// A rebuild depends on everything under src/ except tests (client scripts
// import across glv and Tailwind scans views for class names) plus the
// lockfile (a dependency bump changes the bundle even when no source
// moves).
const DEFAULT_INPUT_ROOTS = [
  join(PROJECT_ROOT, "src"),
  join(PROJECT_ROOT, "pnpm-lock.yaml"),
];

type Hash = ReturnType<typeof createHash>;

const hashFileInto = (path: string, hash: Hash): void => {
  hash.update(path);
  hash.update("\0");
  hash.update(readFileSync(path));
  hash.update("\0");
};

const hashDirInto = (dir: string, hash: Hash): void => {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tests") hashDirInto(path, hash);
    } else if (entry.isFile()) hashFileInto(path, hash);
  }
};

// Freshness is judged from a content fingerprint of the inputs, not from
// mtimes: the Tailwind CLI preserves the output's mtime when the compiled
// CSS is unchanged, so a touched-but-equivalent source would leave an
// mtime check reporting stale forever.
const inputsFingerprint = (roots: readonly string[]): string => {
  const hash = createHash("sha256");
  for (const root of roots) {
    const stat = statSync(root, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isDirectory()) hashDirInto(root, hash);
    else hashFileInto(root, hash);
  }
  return hash.digest("hex");
};

const manifestPath = (outputDir: string): string =>
  join(outputDir, "build-manifest.json");

// The fingerprint recorded at the last successful build; undefined when
// the manifest is missing, corrupt, or off-contract — any of which
// forces a rebuild.
const BuildManifest = type({ "fingerprint?": "unknown" });

const recordedFingerprint = (outputDir: string): unknown => {
  try {
    const manifest = BuildManifest(
      JSON.parse(readFileSync(manifestPath(outputDir), "utf-8")),
    );
    return manifest instanceof type.errors ? undefined : manifest.fingerprint;
  } catch {
    return undefined;
  }
};

// The manifest alone says the inputs are current, but the outputs it
// vouches for can still be broken on disk: a build killed mid-write
// (systemd cgroup stop, Ctrl+C, OOM, disk-full) leaves a truncated file
// beside a manifest from the last successful build — whose fingerprint
// still matches, since the sources did not change. Serving that state
// ships an empty or half-written stylesheet, so freshness is judged
// from content AND integrity: every output must exist and be non-empty
// to count as reusable.
const assetsUpToDate = (outputDir: string, fingerprint: string): boolean => {
  if (recordedFingerprint(outputDir) !== fingerprint) return false;
  return OUTPUT_FILES.every((name) => {
    try {
      return statSync(join(outputDir, name)).size > 0;
    } catch {
      return false;
    }
  });
};

// Writes via a pid-suffixed sibling temp file renamed into place, so two
// concurrent builds (parallel vitest files each booting serve, a `pnpm
// build` racing a boot) never interleave partial writes into a target
// that readers and the up-to-date gate treat as whole. A crash between
// write and rename leaves only an inert dot-tmp behind, never a
// truncated output beside a matching manifest.
const writeAssetAtomic = (
  outputDir: string,
  name: string,
  data: string | Uint8Array,
): void => {
  const tmp = join(outputDir, `.${basename(name)}.${process.pid}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, join(outputDir, name));
};

type BuildAssetsOptions = {
  /** Overrides dist/<flavor> as the output directory (tests use a scratch dir). */
  readonly outputDir?: string;
  /** Overrides the hashed input roots (src/ and the lockfile by default). */
  readonly inputRoots?: readonly string[];
};

// Builds one flavor's static assets into dist/<flavor>/: the compiled
// stylesheet plus every bundled client entry. Called by each flavor's
// build.ts wrapper (the pnpm build:assets entries) and by serve — which
// boots once per test file in the integration suite, so a matching
// fingerprint skips the rebuild instead of paying it on every boot.
// Returns true when a build ran, false when the outputs were reused.
const buildAssets = (
  flavor: string,
  options: BuildAssetsOptions = {},
): boolean => {
  const outputDir = options.outputDir ?? join(PROJECT_ROOT, "dist", flavor);
  const fingerprint = inputsFingerprint(
    options.inputRoots ?? DEFAULT_INPUT_ROOTS,
  );
  if (assetsUpToDate(outputDir, fingerprint)) return false;
  mkdirSync(outputDir, { recursive: true });
  // Tailwind writes the stylesheet in place; land it on a sibling temp
  // path so a reader (or a second builder) never sees a partial file.
  const cssTmp = join(outputDir, `.app.css.${process.pid}.tmp`);
  execaSync(
    process.execPath,
    [
      TAILWIND_ENTRY,
      "-i",
      join(GLV_SRC, "styles", "app.css"),
      "-o",
      cssTmp,
      "--minify",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  renameSync(cssTmp, join(outputDir, "app.css"));
  // Bundled in memory and written through the same atomic path as the
  // stylesheet: buildSync's direct writes have the same partial-file
  // exposure as the CLI's.
  const bundled = buildSync({
    entryPoints: CLIENT_ENTRIES,
    bundle: true,
    format: "iife",
    minify: true,
    outdir: outputDir,
    platform: "browser",
    target: ["es2020"],
    write: false,
  });
  if (bundled.outputFiles === undefined)
    throw new Error("esbuild returned no output files");
  for (const file of bundled.outputFiles)
    writeAssetAtomic(outputDir, basename(file.path), file.contents);
  writeAssetAtomic(
    outputDir,
    basename(manifestPath(outputDir)),
    `${JSON.stringify({ fingerprint })}\n`,
  );
  console.log(`glv assets built → ${outputDir}`);
  return true;
};

export { buildAssets };
