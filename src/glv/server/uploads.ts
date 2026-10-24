import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { resolveDataPath } from "../db-path.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MB across all uploads
const SESSION_MARKER = ".glv-session-id";

const resolveUploadsBase = (dataDirName: string): string =>
  resolveDataPath(undefined, "GLV_UPLOADS_DIR", dataDirName, "uploads");

const resolveUploadDir = (dataDirName: string, id: string): string =>
  join(resolveUploadsBase(dataDirName), id);

// Temp working dirs live under GLV's data dir so the tag-and-sweep
// lifecycle cleans them up on archive.
const resolveTempBase = (dataDirName: string): string =>
  resolveDataPath(undefined, "GLV_TEMP_DIR", dataDirName, "tmp");

// Strip path components and unsafe characters so a filename can never escape
// the per-session upload dir.
const sanitizeFilename = (name: string): string => {
  const cleaned = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned === "" || cleaned === "." ? "upload" : cleaned;
};

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

const uploadErrorMessage = (err: unknown): string =>
  err instanceof UploadError ? err.message : "Failed to save uploaded files.";

// Appends -1, -2, ... before the extension until the name is unused.
const uniqueName = (name: string, used: Set<string>): string => {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 1;
  let candidate = `${stem}-${i}${ext}`;
  while (used.has(candidate)) {
    i++;
    candidate = `${stem}-${i}${ext}`;
  }
  return candidate;
};

type SavedUpload = { paths: string[]; dir: string };

// The form-body normalization in forms.ts yields a single File or File[]
// for the same field name; flatten to File[], dropping zero-size entries.
const collectFiles = (raw: unknown): File[] => {
  const files: File[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) if (v instanceof File && v.size > 0) files.push(v);
  } else if (raw instanceof File && raw.size > 0) files.push(raw);
  return files;
};

// Writes each file into a fresh per-batch directory. The real session id
// isn't known until the agent creates it, so the dir is named with a uuid and the
// caller tags it onto the session id later (tagDir).
const saveUploads = async (
  files: File[],
  dataDirName: string,
): Promise<SavedUpload> => {
  const dir = resolveUploadDir(dataDirName, randomUUID());
  mkdirSync(dir, { recursive: true });
  // A mid-batch failure (size limit, write error) must not strand a
  // partially-populated directory: it is untagged, so the tag-and-sweep
  // cleanup would never collect it.
  try {
    return await writeBatch(files, dir);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
};

// Writes the files one at a time, enforcing the per-file and total size
// limits as the batch accumulates and giving each a collision-free name.
const writeBatch = async (files: File[], dir: string): Promise<SavedUpload> => {
  let totalSize = 0;
  const used = new Set<string>();
  const paths: string[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE)
      throw new UploadError(
        `"${file.name}" is ${formatFileSize(file.size)} — the limit is ${formatFileSize(MAX_FILE_SIZE)}.`,
      );

    totalSize += file.size;
    if (totalSize > MAX_TOTAL_SIZE)
      throw new UploadError(
        `Total upload size exceeds ${formatFileSize(MAX_TOTAL_SIZE)}.`,
      );

    const name = uniqueName(sanitizeFilename(file.name), used);
    used.add(name);
    const dest = join(dir, name);
    writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
    paths.push(dest);
  }
  return { paths, dir };
};

// Appends an absolute-path reference section to the prompt so the agent reads the
// files regardless of its working directory.
const buildUploadContext = (paths: string[]): string => {
  if (paths.length === 0) return "";
  const list = paths.map((p) => `- ${p}`).join("\n");
  return `\n\n---\nAttached files (read them as needed):\n${list}`;
};

// The ids owning a managed directory, one per line in the marker file.
// A single-owner marker is the common case; a temp working dir shared
// with a fork lists every owner so the sweep can outlive the first
// archive (#367).
const markerIds = (markerPath: string): string[] =>
  readFileSync(markerPath, "utf-8")
    .trim()
    .split(/\s+/)
    .filter((id) => id !== "");

// Records a session as an owner of a managed directory. The marker keeps
// every owner's id (a fork shares its source's temp working dir, #367);
// re-tagging an id already present changes nothing. The dir keeps its
// uuid name because renaming would break the absolute paths already
// handed to the agent for the run's lifetime.
const tagDir = (dir: string, sessionId: string): void => {
  const markerPath = join(dir, SESSION_MARKER);
  const existing = existsSync(markerPath) ? markerIds(markerPath) : [];
  const owners = existing.includes(sessionId)
    ? existing
    : [...existing, sessionId];
  writeFileSync(markerPath, `${owners.join("\n")}\n`);
};

// Adds a fork's id to a managed temp dir's ownership marker (#367): the
// fork shares its source's working directory, so the directory must be
// swept only after every owner is archived or deleted. Anything else —
// a session whose working dir sits outside GLV's temp base, or a dir
// that no longer exists — is left alone.
const shareTempDir = (
  dataDirName: string,
  workingDir: string,
  sessionId: string,
): void => {
  const base = resolveTempBase(dataDirName);
  const rel = relative(base, workingDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
  if (!existsSync(workingDir)) return;
  tagDir(workingDir, sessionId);
};

// Windows can transiently refuse a recursive delete with EPERM while the
// OS finishes tearing down a process that used the directory as its cwd —
// stop() only initiates the kill, so the archive/create sweeps can race
// agent teardown. Retries ride out that window and are harmless no-ops on
// POSIX, where the first attempt succeeds.
const RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 20,
  retryDelay: 100,
} as const;

// Removes any sub-directory the session owns — its marker names the
// session id — but only once no owner listed in the marker is still in
// use: a fork shares its source's temp working dir (#367), so the
// directory outlives the first owner's archive and is swept by the last
// one out. Untagged dirs (from crashed sessions) are left untouched.
const deleteTaggedDir = (
  base: string,
  sessionId: string,
  ownerInUse: (id: string) => boolean,
): void => {
  if (!existsSync(base)) return;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const markerPath = join(base, entry.name, SESSION_MARKER);
    if (!existsSync(markerPath)) continue;
    const owners = markerIds(markerPath);
    if (!owners.includes(sessionId)) continue;
    if (owners.some(ownerInUse)) continue;
    rmSync(join(base, entry.name), RM_OPTIONS);
  }
};

const deleteUploads = (
  dataDirName: string,
  sessionId: string,
  ownerInUse: (id: string) => boolean,
): void =>
  deleteTaggedDir(resolveUploadsBase(dataDirName), sessionId, ownerInUse);

const createTempDir = (dataDirName: string): string => {
  const dir = join(resolveTempBase(dataDirName), randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
};

const deleteTempDir = (
  dataDirName: string,
  sessionId: string,
  ownerInUse: (id: string) => boolean,
): void => deleteTaggedDir(resolveTempBase(dataDirName), sessionId, ownerInUse);

// Pre-tag failure cleanup — the sweep can only find tagged directories.
const removeDir = (dir: string): void => {
  rmSync(dir, RM_OPTIONS);
};

export {
  buildUploadContext,
  collectFiles,
  createTempDir,
  deleteTempDir,
  deleteUploads,
  removeDir,
  saveUploads,
  shareTempDir,
  tagDir,
  uploadErrorMessage,
};
