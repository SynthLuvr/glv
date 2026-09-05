import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
// the manifest is missing or corrupt, which forces a rebuild.
const recordedFingerprint = (outputDir: string): unknown => {
  try {
    const manifest = JSON.parse(
      readFileSync(manifestPath(outputDir), "utf-8"),
    ) as { fingerprint?: unknown } | null;
    return manifest?.fingerprint;
  } catch {
    return undefined;
  }
};

const assetsUpToDate = (outputDir: string, fingerprint: string): boolean =>
  recordedFingerprint(outputDir) === fingerprint &&
  OUTPUT_FILES.every((name) => existsSync(join(outputDir, name)));

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
  execaSync(
    process.execPath,
    [
      TAILWIND_ENTRY,
      "-i",
      join(GLV_SRC, "styles", "app.css"),
      "-o",
      join(outputDir, "app.css"),
      "--minify",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  buildSync({
    entryPoints: CLIENT_ENTRIES,
    bundle: true,
    format: "iife",
    minify: true,
    outdir: outputDir,
    platform: "browser",
    target: ["es2020"],
  });
  writeFileSync(
    manifestPath(outputDir),
    `${JSON.stringify({ fingerprint })}\n`,
  );
  console.log(`glv assets built → ${outputDir}`);
  return true;
};

export { buildAssets };
