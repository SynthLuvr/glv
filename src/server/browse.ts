import { type Dirent, lstatSync, readdirSync, type Stats } from "node:fs";
import { join, resolve, sep } from "node:path";

type BrowseEntry = {
  name: string;
  isDir: boolean;
  size: number;
};

type ResolvedPath =
  | { ok: true; abs: string; rel: string; stat: Stats }
  | { ok: false; status: 400 | 404 };

// Splits the request sub-path on a literal "/" then URI-decodes each segment
// exactly once. A segment is rejected when it is a dotfile (this also covers
// "." and ".."), contains a path separator after decoding (an encoded "%2F"
// smuggling in a slash), a backslash, or a NUL byte. Because the split happens
// before decoding, "%2F" stays inside one segment and is caught post-decode.
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
    if (
      part.startsWith(".") ||
      part.includes("/") ||
      part.includes("\\") ||
      part.includes("\0")
    )
      return { status: 404 };
    out.push(part);
  }
  return out;
};

// Resolves a browser sub-path (the portion after /browse or /files) to an
// absolute path inside `root`, refusing escapes, dotfiles, and symlinks.
// Every ancestor is checked with lstat — never stat — so a symlinked directory
// nested in the path can never pull content in from outside the root.
const resolveBrowsePath = (root: string, sub: string): ResolvedPath => {
  const rootResolved = resolve(root);
  const decoded = decodeSegments(sub);
  if (!Array.isArray(decoded)) return { ok: false, status: decoded.status };

  let cur = rootResolved;
  let stat: Stats;
  try {
    stat = lstatSync(cur);
  } catch {
    return { ok: false, status: 404 };
  }
  if (stat.isSymbolicLink()) return { ok: false, status: 404 };

  for (const part of decoded) {
    cur = join(cur, part);
    try {
      stat = lstatSync(cur);
    } catch {
      return { ok: false, status: 404 };
    }
    if (stat.isSymbolicLink()) return { ok: false, status: 404 };
  }

  // Defence-in-depth containment: the resolved path must be the root itself or
  // sit directly beneath it. Dotfile rejection already blocks "..", but this
  // keeps the invariant explicit and guards against future segment rules.
  if (cur !== rootResolved && !cur.startsWith(`${rootResolved}${sep}`))
    return { ok: false, status: 404 };

  return { ok: true, abs: cur, rel: decoded.join("/"), stat };
};

// Reads a contained directory, dropping dotfiles and symlinks and anything
// that isn't a plain file or folder. Folders sort before files; within a group
// the order is alphabetical, case-insensitive, with natural numeric ordering.
const listBrowseDir = (abs: string): BrowseEntry[] => {
  const entries: Dirent[] = readdirSync(abs, { withFileTypes: true });
  const out: BrowseEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      out.push({ name: entry.name, isDir: true, size: 0 });
    } else if (entry.isFile())
      try {
        out.push({
          name: entry.name,
          isDir: false,
          size: lstatSync(join(abs, entry.name)).size,
        });
      } catch {
        /* vanished between readdir and lstat — skip it */
      }
  }
  out.sort((a, b) =>
    a.isDir === b.isDir
      ? a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
          numeric: true,
        })
      : a.isDir
        ? -1
        : 1,
  );
  return out;
};

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

// The sub-path portion of a request path: "/browse" → "", "/browse/a/b" → "a/b".
// Only matches the exact prefix or prefix + "/", so "/browser" is left alone.
const subPathOf = (reqPath: string, prefix: string): string =>
  reqPath === prefix
    ? ""
    : reqPath.startsWith(`${prefix}/`)
      ? reqPath.slice(prefix.length + 1)
      : "";

// The parent sub-path: "a/b" → "a", "a" → "", "" → "".
const parentRel = (rel: string): string => {
  const idx = rel.lastIndexOf("/");
  return idx < 0 ? "" : rel.slice(0, idx);
};

export type { BrowseEntry, ResolvedPath };
export {
  formatFileSize,
  listBrowseDir,
  parentRel,
  resolveBrowsePath,
  subPathOf,
};
