#!/usr/bin/env tsx
/**
 * One-location rule: byte-identical source may exist in only ONE of
 * src/goose/, src/claude/, or src/glv/.
 *
 *   pnpm lint:mirrored -> tsx scripts/mirrored-files.mts
 *
 * A relative path present in two or more trees with IDENTICAL content is
 * "mirrored" consolidation debt. The transitional exemption list that
 * tracked this during the consolidation was removed once it emptied; the
 * rule is now absolute.
 *
 * Same-path files with genuinely different content (flavor adapters,
 * profiles) are the intended end-state architecture — they are NOT flagged
 * here; shared code fragments between them are caught by lint:cross-tree.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TREES = ["goose", "claude", "glv"] as const;

const walk = (dir: string, base = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    return entry.isDirectory() ? walk(join(dir, entry.name), rel) : [rel];
  });

// Tree-relative paths whose copies are byte-identical across two or more
// trees.
const mirroredPaths = (): string[] => {
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
  const isMirrored = (byTree: Map<string, Buffer>): boolean => {
    if (byTree.size < 2) return false;
    const [first, ...rest] = [...byTree.values()];
    return rest.every((buf) => buf.equals(first));
  };
  return [...contents.entries()]
    .filter(([, byTree]) => isMirrored(byTree))
    .map(([rel]) => rel)
    .sort((a, b) => a.localeCompare(b));
};

const checkOneLocation = (): void => {
  const mirrored = mirroredPaths();
  if (mirrored.length > 0)
    throw new Error(
      "Mirrored file(s) — identical content may exist in only ONE of " +
        "src/goose, src/claude, or src/glv:\n  " +
        mirrored.join("\n  ") +
        "\n\nPut the shared copy in src/glv, or make the two flavors " +
        "genuinely different.",
    );

  console.log("One-location rule holds: no identical-content mirrors.");
};

try {
  checkOneLocation();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
