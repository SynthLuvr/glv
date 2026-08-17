import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { execaSync } from "execa";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(SRC_DIR, "..", "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "dist", "claude");
const CSS_INPUT = join(SRC_DIR, "styles", "app.css");
const CSS_OUTPUT = join(OUTPUT_DIR, "app.css");
const TAILWIND_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "tailwindcss");

// Bundle every client entry into a self-contained IIFE in one pass, so any
// script may import shared modules (e.g. ./shared) without bespoke config.
const CLIENT_ENTRIES = [
  "sidebar",
  "stream",
  "rename",
  "ui",
  "groups",
  "prompts",
  "passkey",
  "uploads",
].map((name) => join(SRC_DIR, "scripts", `${name}.ts`));

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
    entryPoints: CLIENT_ENTRIES,
    bundle: true,
    format: "iife",
    minify: true,
    outdir: OUTPUT_DIR,
    platform: "browser",
    target: ["es2020"],
  });
};

// Allows running directly via "tsx src/claude/build.ts" (the build:assets script)
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
