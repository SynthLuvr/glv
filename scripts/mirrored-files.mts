#!/usr/bin/env tsx
/**
 * One-location rule: a source file may live in src/goose/, src/claude/, or
 * src/glv/ — never in more than one of them.
 *
 *   pnpm lint:mirrored -> tsx scripts/mirrored-files.mts
 *
 * A relative path that exists in two or more of the three trees is
 * "mirrored". Mirrored files pre-dating the glv-core consolidation are
 * listed in scripts/mirrored-exemptions.json; that list only ever shrinks
 * as files are moved into src/glv, and it is deleted once empty.
 *
 * Fails when:
 *   - a mirrored path is not on the exemption list (new duplication), or
 *   - an exempted path is no longer mirrored (a stale entry to remove).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TREES = ["goose", "claude", "glv"] as const;
const EXEMPTIONS_PATH = join(ROOT, "scripts", "mirrored-exemptions.json");

const walk = (dir: string, base = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    return entry.isDirectory() ? walk(join(dir, entry.name), rel) : [rel];
  });

const mirroredPaths = (): Map<string, string[]> => {
  const locations = new Map<string, string[]>();
  for (const tree of TREES) {
    const dir = join(ROOT, "src", tree);
    if (!existsSync(dir)) continue;
    for (const rel of walk(dir)) {
      const trees = locations.get(rel) ?? [];
      trees.push(tree);
      locations.set(rel, trees);
    }
  }
  return new Map(
    [...locations.entries()]
      .filter(([, trees]) => trees.length > 1)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
};

const loadExemptions = (): string[] =>
  existsSync(EXEMPTIONS_PATH)
    ? (JSON.parse(readFileSync(EXEMPTIONS_PATH, "utf8")) as string[])
    : [];

const checkOneLocation = (): void => {
  const mirrored = mirroredPaths();
  const exemptions = loadExemptions();
  const exempted = new Set(exemptions);

  const unlisted = [...mirrored.keys()].filter((rel) => !exempted.has(rel));
  const stale = exemptions.filter((rel) => !mirrored.has(rel));

  if (unlisted.length > 0)
    throw new Error(
      "New mirrored file(s) — a path may exist in only ONE of " +
        "src/goose, src/claude, or src/glv:\n  " +
        unlisted.join("\n  ") +
        "\n\nPut the shared copy in src/glv, or make the two flavors " +
        "genuinely different.",
    );

  if (stale.length > 0)
    throw new Error(
      "Stale exemption(s) — no longer mirrored, so remove them from " +
        "scripts/mirrored-exemptions.json (the list only shrinks):\n  " +
        stale.join("\n  "),
    );

  console.log(
    `One-location rule holds: ${mirrored.size} exempted mirrored ` +
      "path(s), none unlisted, none stale.",
  );
};

try {
  checkOneLocation();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
