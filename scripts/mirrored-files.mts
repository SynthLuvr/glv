#!/usr/bin/env tsx
/**
 * One-location rule: byte-identical source may exist in only ONE of
 * src/goose/, src/claude/, or src/glv/.
 *
 *   pnpm lint:mirrored -> tsx scripts/mirrored-files.mts
 *
 * A relative path present in two or more trees with IDENTICAL content is
 * "mirrored" consolidation debt. The transitional exemption list that tracked this during the
 * consolidation was removed once it emptied; the rule is now absolute.
 *
 * Same-path files with genuinely different content (flavor adapters,
 * profiles) are the intended end-state architecture — they are NOT flagged
 * here; shared code fragments between them are caught by lint:cross-tree.
 *
 * Fails when:
 *   - an identical-content mirror is not on the exemption list, or
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

// relpath -> trees holding it, plus whether every copy is byte-identical.
const mirroredPaths = (): Map<string, string[]> => {
  const contents = new Map<string, Map<string, Buffer>>();
  for (const tree of TREES) {
    const dir = join(ROOT, "src", tree);
    if (!existsSync(dir)) continue;
    for (const rel of walk(dir)) {
      const byTree = contents.get(rel) ?? new Map<string, Buffer>();
      byTree.set(tree, readFileSync(join(dir, rel)));
      contents.set(rel, byTree);
    }
  }
  return new Map(
    [...contents.entries()]
      .filter(([, byTree]) => {
        if (byTree.size < 2) return false;
        const [first, ...rest] = [...byTree.values()];
        return rest.every((buf) => buf.equals(first));
      })
      .map(([rel, byTree]) => [rel, [...byTree.keys()]])
      .sort(([a], [b]) => a.localeCompare(b)) as [string, string[]][],
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
      "New mirrored file(s) — identical content may exist in only ONE of " +
        "src/goose, src/claude, or src/glv:\n  " +
        unlisted.join("\n  ") +
        "\n\nPut the shared copy in src/glv, or make the two flavors " +
        "genuinely different.",
    );

  if (stale.length > 0)
    throw new Error(
      "Stale exemption(s) — no longer identical-content mirrors, so remove " +
        "them from scripts/mirrored-exemptions.json (the list only " +
        "shrinks):\n  " +
        stale.join("\n  "),
    );

  console.log(
    `One-location rule holds: ${mirrored.size} exempted identical ` +
      "mirror(s), none unlisted, none stale.",
  );
};

try {
  checkOneLocation();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
