import { mkdirSync } from "node:fs";
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
const CLIENT_ENTRIES = [
  "sidebar",
  "stream",
  "rename",
  "ui",
  "groups",
  "prompts",
  "passkey",
  "uploads",
].map((name) => join(GLV_SRC, "scripts", `${name}.ts`));

// Builds one flavor's static assets into dist/<flavor>/: the compiled
// stylesheet plus every bundled client entry. Called by each flavor's
// build.ts wrapper (the pnpm build:assets entries) and by serve.
const buildAssets = (flavor: string): void => {
  const outputDir = join(PROJECT_ROOT, "dist", flavor);
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
  console.log(`glv assets built → ${outputDir}`);
};

export { buildAssets };
