import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { execaSync } from "execa";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(SRC_DIR, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "dist");
const CSS_INPUT = join(SRC_DIR, "styles", "app.css");
const CSS_OUTPUT = join(OUTPUT_DIR, "app.css");
const TAILWIND_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "tailwindcss");
const SCRIPT_ENTRIES = [
  join(SRC_DIR, "scripts", "sidebar.ts"),
  join(SRC_DIR, "scripts", "stream.ts"),
  join(SRC_DIR, "scripts", "theme.ts"),
  join(SRC_DIR, "scripts", "markdown-copy.ts"),
  join(SRC_DIR, "scripts", "rename.ts"),
  join(SRC_DIR, "scripts", "source-picker.ts"),
  join(SRC_DIR, "scripts", "ui.ts"),
  join(SRC_DIR, "scripts", "prompts.ts"),
];

const ensureDistDir = (): void => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
};

const buildStyles = (): void => {
  ensureDistDir();
  execaSync(TAILWIND_BIN, ["-i", CSS_INPUT, "-o", CSS_OUTPUT, "--minify"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
};

const buildScripts = (): void => {
  ensureDistDir();
  buildSync({
    entryPoints: SCRIPT_ENTRIES,
    outdir: OUTPUT_DIR,
    minify: true,
    target: ["es2020"],
  });
  // Bundled separately: passkey.ts imports @simplewebauthn/browser, which must
  // be inlined into a self-contained IIFE (the package's exports map blocks
  // direct subpath access to its prebuilt UMD bundle).
  buildSync({
    entryPoints: [join(SRC_DIR, "scripts", "passkey.ts")],
    outfile: join(OUTPUT_DIR, "passkey.js"),
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
  });
};

// Allows running directly via "tsx src/build.ts" (the build:assets script)
// as well as being imported by the serve command.
const isMain = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return (
    pathToFileURL(entry).href === import.meta.url || entry.endsWith("build.ts")
  );
};

if (isMain()) {
  buildStyles();
  buildScripts();
  console.log(`glv assets built → ${OUTPUT_DIR}`);
}

export { buildScripts, buildStyles };
