import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAssets } from "../build.js";

// Exercises the real Tailwind + esbuild build against a scratch tree:
// serve calls buildAssets on every boot and the integration suite boots a
// server per test file, so a wrong rebuild decision either wastes a second
// per boot or serves stale assets.
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "glv-build-assets-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const seedInputs = (): void => {
  mkdirSync(join(scratch, "src", "styles"), { recursive: true });
  mkdirSync(join(scratch, "src", "views"), { recursive: true });
  mkdirSync(join(scratch, "src", "tests"), { recursive: true });
  writeFileSync(join(scratch, "src", "styles", "app.css"), "body {}\n");
  writeFileSync(join(scratch, "src", "views", "view.tsx"), "export {}\n");
  writeFileSync(join(scratch, "src", "tests", "ignored.test.ts"), "x\n");
  writeFileSync(join(scratch, "pnpm-lock.yaml"), "lockfile: 1\n");
};

const build = (): boolean =>
  buildAssets("scratch", {
    outputDir: join(scratch, "dist"),
    inputRoots: [join(scratch, "src"), join(scratch, "pnpm-lock.yaml")],
  });

describe("buildAssets incremental", () => {
  it("builds the first time and reuses outputs while inputs are unchanged", () => {
    seedInputs();
    expect(build()).toBe(true);
    expect(build()).toBe(false);
  });

  it("rebuilds when a hashed input changes", () => {
    seedInputs();
    expect(build()).toBe(true);
    writeFileSync(
      join(scratch, "src", "views", "view.tsx"),
      "export const extra = 1;\n",
    );
    expect(build()).toBe(true);
    expect(build()).toBe(false);
  });

  it("ignores test files under a tests/ directory", () => {
    seedInputs();
    expect(build()).toBe(true);
    writeFileSync(join(scratch, "src", "tests", "ignored.test.ts"), "y\n");
    expect(build()).toBe(false);
  });

  it("rebuilds when the lockfile changes", () => {
    seedInputs();
    expect(build()).toBe(true);
    writeFileSync(join(scratch, "pnpm-lock.yaml"), "lockfile: 2\n");
    expect(build()).toBe(true);
  });

  it("rebuilds when an output goes missing even with a fresh manifest", () => {
    seedInputs();
    expect(build()).toBe(true);
    rmSync(join(scratch, "dist", "sidebar.js"));
    expect(build()).toBe(true);
    expect(build()).toBe(false);
  });

  it("rebuilds when the manifest is missing", () => {
    seedInputs();
    expect(build()).toBe(true);
    rmSync(join(scratch, "dist", "build-manifest.json"));
    expect(build()).toBe(true);
  });

  it("rebuilds when the manifest is corrupt", () => {
    seedInputs();
    expect(build()).toBe(true);
    writeFileSync(join(scratch, "dist", "build-manifest.json"), "null");
    expect(build()).toBe(true);
  });
});
