import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { resolveDataPath } from "../db-path.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MB across all uploads

const resolveUploadsBase = (): string =>
  resolveDataPath(undefined, "GLV_UPLOADS_DIR", "glv", "uploads");

const resolveUploadDir = (sessionId: string): string =>
  join(resolveUploadsBase(), sessionId);

// Strip path components and unsafe characters so an uploaded filename can
// never escape the per-session upload dir.
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

// Resolves filename collisions inside a session's upload dir by appending
// -1, -2, etc. before the extension.
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

// Writes each file into a fresh per-batch directory under GLV's private
// uploads area. Returns the absolute paths so they can be handed to goose,
// plus the temp dir so the caller can move it onto the real session id once
// goose has created it.
const saveUploads = async (files: File[]): Promise<SavedUpload> => {
  const uploadId = randomUUID();
  const dir = resolveUploadDir(uploadId);
  mkdirSync(dir, { recursive: true });

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

// Appends a file-reference section to the prompt so goose knows where to find
// the uploaded files. Paths are absolute so goose resolves them regardless of
// its working directory.
const buildUploadContext = (paths: string[]): string => {
  if (paths.length === 0) return "";
  const list = paths.map((p) => `- ${p}`).join("\n");
  return `\n\n---\nAttached files (read them as needed):\n${list}`;
};

const SESSION_MARKER = ".glv-session-id";

// Writes a marker file inside the upload dir so cleanup can find it by
// session id on archive. Files stay in the original (uuid-named) dir so the
// paths handed to goose remain valid for the lifetime of the run — renaming
// after goose starts would create a race where the prompt's file paths
// suddenly point at a moved directory.
const tagUploadDir = (dir: string, sessionId: string): void => {
  writeFileSync(join(dir, SESSION_MARKER), sessionId);
};

// Scans the uploads base dir for a sub-dir tagged with the given session id
// and removes it. Untagged dirs (from crashed sessions) are left untouched.
const deleteUploads = (sessionId: string): void => {
  const base = resolveUploadsBase();
  if (!existsSync(base)) return;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const markerPath = join(base, entry.name, SESSION_MARKER);
    if (!existsSync(markerPath)) continue;
    if (readFileSync(markerPath, "utf-8").trim() === sessionId)
      rmSync(join(base, entry.name), { recursive: true, force: true });
  }
};

const deleteUploadDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

export {
  buildUploadContext,
  deleteUploadDir,
  deleteUploads,
  formatFileSize,
  MAX_FILE_SIZE,
  resolveUploadDir,
  saveUploads,
  tagUploadDir,
  UploadError,
};
