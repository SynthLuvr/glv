import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join, resolve, sep } from "node:path";

type BrowseEntry = {
  name: string;
  isDir: boolean;
  size: number;
};

type ResolvedPath =
  | { ok: true; abs: string; rel: string; stat: Stats }
  | { ok: false; status: 400 | 404 };

// lstat — never stat — so a symlink anywhere in the path can never pull content
// in from outside the root. A missing path or any symlink is treated as unsafe.
const safeStat = (path: string): Stats | undefined => {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  return stat.isSymbolicLink() ? undefined : stat;
};

// Blocks dotfiles (covers "." and "..": secrets and traversal), a decoded path
// separator (an encoded "%2F" smuggling in a slash), a backslash, or a NUL.
const isUnsafeSegment = (part: string): boolean =>
  part.startsWith(".") ||
  part.includes("/") ||
  part.includes("\\") ||
  part.includes("\0");

// Splits the sub-path on a literal "/" then URI-decodes each segment once.
// The split happens before decoding, so "%2F" stays inside one segment and is
// caught by isUnsafeSegment after it decodes to "/".
const decodeSegments = (sub: string): string[] | { status: 400 | 404 } => {
  const out: string[] = [];
  for (const raw of sub.split("/")) {
    if (raw === "") continue;
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return { status: 400 };
    }
    if (isUnsafeSegment(part)) return { status: 404 };
    out.push(part);
  }
  return out;
};

// Resolves a sub-path (the portion after /browse or /files) to an absolute
// path inside `root`, refusing escapes, dotfiles, and symlinks. Every ancestor
// is statted so a nested symlink can never escape the root.
const resolveBrowsePath = (root: string, sub: string): ResolvedPath => {
  const rootResolved = resolve(root);
  const decoded = decodeSegments(sub);
  if (!Array.isArray(decoded)) return { ok: false, status: decoded.status };

  let cur = rootResolved;
  let stat = safeStat(cur);
  if (stat === undefined) return { ok: false, status: 404 };
  for (const part of decoded) {
    cur = join(cur, part);
    stat = safeStat(cur);
    if (stat === undefined) return { ok: false, status: 404 };
  }

  // Defence-in-depth: dotfile rejection already blocks ".."; this keeps the
  // containment invariant explicit against future segment rules.
  if (cur !== rootResolved && !cur.startsWith(`${rootResolved}${sep}`))
    return { ok: false, status: 404 };

  return { ok: true, abs: cur, rel: decoded.join("/"), stat };
};

// Reads a contained directory, dropping dotfiles and symlinks. Folders sort
// before files; within a group the order is alphabetical, case-insensitive,
// with natural numeric ordering.
const listBrowseDir = (abs: string): BrowseEntry[] => {
  const entries = readdirSync(abs, { withFileTypes: true });
  const out: BrowseEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      out.push({ name: entry.name, isDir: true, size: 0 });
    } else if (entry.isFile()) {
      const stat = safeStat(join(abs, entry.name));
      if (stat !== undefined)
        out.push({ name: entry.name, isDir: false, size: stat.size });
    }
  }
  out.sort(compareEntries);
  return out;
};

const compareEntries = (a: BrowseEntry, b: BrowseEntry): number =>
  a.isDir === b.isDir
    ? a.name.localeCompare(b.name, undefined, {
        sensitivity: "base",
        numeric: true,
      })
    : a.isDir
      ? -1
      : 1;

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const childRel = (rel: string, name: string): string =>
  rel === "" ? name : `${rel}/${name}`;

const parentRel = (rel: string): string => {
  const idx = rel.lastIndexOf("/");
  return idx < 0 ? "" : rel.slice(0, idx);
};

export type { BrowseEntry };
export {
  childRel,
  formatFileSize,
  listBrowseDir,
  parentRel,
  resolveBrowsePath,
};
