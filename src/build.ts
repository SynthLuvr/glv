import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execaSync } from "execa";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = join(SRC_DIR, "..");
const INPUT = join(SRC_DIR, "styles", "app.css");
const OUTPUT_DIR = join(PROJECT_ROOT, "dist");
const OUTPUT = join(OUTPUT_DIR, "app.css");
const TAILWIND_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "tailwindcss");

// Compiles src/styles/app.css → dist/app.css so the viewer always serves
// current styles. Called by `glv serve` and the build:css script.
const buildStyles = (): void => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  execaSync(TAILWIND_BIN, ["-i", INPUT, "-o", OUTPUT, "--minify"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
};

// Allows running directly via "tsx src/build.ts" (the build:css script)
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
  console.log(`glv styles built → ${OUTPUT}`);
}

export { buildStyles };
