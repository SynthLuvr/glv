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
];

// Compiles src/styles/app.css → dist/app.css so the viewer always serves
// current styles. Called by `glv serve` and the build:assets script.
const buildStyles = (): void => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  execaSync(TAILWIND_BIN, ["-i", CSS_INPUT, "-o", CSS_OUTPUT, "--minify"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
};

// Compiles src/scripts/*.ts → minified dist/*.js so the viewer always serves
// current client scripts. Called by `glv serve` and the build:assets script.
const buildScripts = (): void => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  buildSync({
    entryPoints: SCRIPT_ENTRIES,
    outdir: OUTPUT_DIR,
    minify: true,
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
