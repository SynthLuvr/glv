import {
  closeSync,
  type Dirent,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { mayFail } from "ts-handling";
import { isRecord, JsonObject, parseJson } from "../../glv/parse.js";

// One parsed message from a claude transcript, with content blocks already
// normalized to the viewer's item model (text/thinking/toolRequest/
// toolResponse) so the rendering layer never sees claude-specific shapes.
type RawMessage = {
  uuid: string | null;
  role: string;
  items: unknown[];
  timestamp: string;
  createdTimestamp: number;
};

// Metadata extracted from a transcript file while scanning it.
type Transcript = {
  cwd: string | undefined;
  firstTimestamp: string | undefined;
  lastTimestamp: string | undefined;
  firstUserTimestamp: number | undefined;
  firstUserText: string | undefined;
  aiTitle: string | undefined;
  model: string | undefined;
  tokens: number | null;
  messages: RawMessage[];
};

type SessionFile = {
  id: string;
  path: string;
  mtimeMs: number;
};

const SESSION_EXT = ".jsonl";

const isSessionFile = (name: string): boolean =>
  name.endsWith(SESSION_EXT) && !name.startsWith(".");

// Sum of the usage counters claude reports per turn. The last one seen wins
// so the sidebar shows the final context size rather than a running total
// that would double-count input tokens on every turn.
const usageTokens = (usage: unknown): number | undefined => {
  if (!isRecord(usage)) return undefined;
  const parts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.output_tokens,
  ].filter((v): v is number => typeof v === "number");
  if (parts.length === 0) return undefined;
  return parts.reduce((sum, n) => sum + n, 0);
};

// A claude content block → the viewer's item model. Unknown block types
// pass through untouched; the transcript renderer stays permissive about
// item types so schema drift degrades instead of breaking.
const normalizeBlock = (block: unknown): unknown => {
  if (typeof block === "string") return { type: "text", text: block };
  if (!isRecord(block)) return block;
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.thinking };
    case "tool_use":
      return {
        type: "toolRequest",
        toolCall: { value: { name: block.name, arguments: block.input } },
      };
    case "tool_result":
      return {
        type: "toolResponse",
        toolResult: {
          value: { content: block.content, isError: block.is_error === true },
        },
      };
    default:
      return block;
  }
};

const normalizeContent = (content: unknown): unknown[] =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content.map(normalizeBlock)
      : [];

// Plain text of a content payload, used to derive a session name from the
// first real user prompt when claude has not produced an ai-title yet.
const contentText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [],
  );
  return texts.length === 0 ? undefined : texts.join("\n");
};

const parseTimestamp = (timestamp: string | undefined): number | undefined => {
  if (timestamp === undefined) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
};

const parseLine = (line: string): Record<string, unknown> | undefined => {
  const parsed = parseJson(line, JsonObject);
  return parsed.ok ? parsed.data : undefined;
};

const emptyTranscript = (): Transcript => ({
  cwd: undefined,
  firstTimestamp: undefined,
  lastTimestamp: undefined,
  firstUserTimestamp: undefined,
  firstUserText: undefined,
  aiTitle: undefined,
  model: undefined,
  tokens: null,
  messages: [],
});

// Facts any line may carry, message or not: the working dir, the first and
// last timestamps, claude's own title, and the freshest usage snapshot —
// usage rides on assistant `message.usage` and top-level `result` lines
// alike.
const applyMetadata = (
  transcript: Transcript,
  parsed: Record<string, unknown>,
): void => {
  if (transcript.cwd === undefined && typeof parsed.cwd === "string")
    transcript.cwd = parsed.cwd;
  if (typeof parsed.timestamp === "string") {
    if (transcript.firstTimestamp === undefined)
      transcript.firstTimestamp = parsed.timestamp;
    transcript.lastTimestamp = parsed.timestamp;
  }
  if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string")
    transcript.aiTitle = parsed.aiTitle;
  const usage =
    usageTokens(isRecord(parsed.message) ? parsed.message.usage : undefined) ??
    usageTokens(parsed.usage);
  if (usage !== undefined) transcript.tokens = usage;
};

// A user/assistant line → a normalized message. The first non-empty user
// prompt also seeds the derived session name and its timestamp.
const appendMessage = (
  transcript: Transcript,
  parsed: Record<string, unknown>,
): void => {
  if (parsed.type !== "user" && parsed.type !== "assistant") return;
  const message = isRecord(parsed.message) ? parsed.message : {};
  const role = typeof message.role === "string" ? message.role : parsed.type;
  if (
    parsed.type === "assistant" &&
    typeof message.model === "string" &&
    message.model !== "" &&
    // Locally generated lines (API-error notices) carry a bracketed
    // "<synthetic>" placeholder, not a model id; name the model that
    // produced the real turns.
    !message.model.startsWith("<")
  )
    transcript.model = message.model;
  const timestamp =
    typeof parsed.timestamp === "string" ? parsed.timestamp : "";
  const createdTimestamp = parseTimestamp(timestamp);
  if (role === "user" && transcript.firstUserText === undefined) {
    const prompt = contentText(message.content);
    if (prompt !== undefined && prompt.trim() !== "") {
      transcript.firstUserText = prompt;
      transcript.firstUserTimestamp = createdTimestamp ?? 0;
    }
  }
  transcript.messages.push({
    uuid: typeof parsed.uuid === "string" ? parsed.uuid : null,
    role,
    items: normalizeContent(message.content),
    timestamp,
    createdTimestamp: createdTimestamp ?? transcript.messages.length,
  });
};

// A transcript is parsed from its whole text in one pass; malformed lines
// are skipped the way the old SQL layer dropped half-written rows.
const parseTranscriptText = (text: string): Transcript => {
  const transcript = emptyTranscript();
  // Editors prepend a UTF-8 BOM when re-saving; JSON.parse rejects it, which
  // would silently drop the first record (usually the first user prompt).
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const line of source.split("\n")) {
    const parsed = parseLine(line);
    if (parsed === undefined) continue;
    // Sub-agent (sidechain) turns belong to claude's internal task tool,
    // not the main conversation the viewer renders.
    if (parsed.isSidechain === true) continue;
    applyMetadata(transcript, parsed);
    appendMessage(transcript, parsed);
  }
  return transcript;
};

// The sidebar and the SSE tails poll the store every few seconds, and
// transcripts can be megabytes — re-parsing every file on every call made
// each poll O(total transcript bytes). Entries are keyed by path and
// invalidated by (mtime, size), so any append or in-place edit — including
// same-size rewrites with a bumped mtime — re-parses. A stat miss or read
// error degrades to an empty transcript rather than throwing.
type CacheEntry = {
  mtimeMs: number;
  size: number;
  text: string;
  transcript: Transcript;
};

const parseCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 500;

const emptyEntry = (): CacheEntry => ({
  mtimeMs: 0,
  size: -1,
  text: "",
  transcript: emptyTranscript(),
});

const readTranscript = (path: string): CacheEntry => {
  const stat = mayFail(() => statSync(path));
  if (!stat.ok) return emptyEntry();
  const { mtimeMs, size } = stat.data;
  const hit = parseCache.get(path);
  if (hit !== undefined && hit.mtimeMs === mtimeMs && hit.size === size)
    return hit;
  const text = mayFail(() => readFileSync(path, "utf8"));
  if (!text.ok) return emptyEntry();
  const entry: CacheEntry = {
    mtimeMs,
    size,
    text: text.data,
    transcript: parseTranscriptText(text.data),
  };
  if (parseCache.size >= MAX_CACHE_ENTRIES) parseCache.clear();
  parseCache.set(path, entry);
  return entry;
};

const parseTranscriptFile = (path: string): Transcript =>
  readTranscript(path).transcript;

// Raw text via the same cache, so PR-candidate scans avoid re-reading too.
const readTranscriptText = (path: string): string => readTranscript(path).text;

// `undefined` when the directory is unreadable — a missing root, a
// permission race, or a project dir that vanished mid-scan.
const listDirEntries = (dir: string): Dirent[] | undefined => {
  const entries = mayFail(() => readdirSync(dir, { withFileTypes: true }));
  return entries.ok ? entries.data : undefined;
};

// All transcript files across project directories, newest mtime first —
// the candidate order the listing walks when filling its window (mtime
// approximates the last transcript timestamp without parsing every
// file); the composite store sorts the final list by each row's own
// updated_at.
const listSessionFiles = (root: string): SessionFile[] => {
  const dirs = listDirEntries(root);
  if (dirs === undefined) return [];
  const out: SessionFile[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
    const entries = listDirEntries(join(root, dir.name));
    if (entries === undefined) continue;
    for (const entry of entries) {
      if (!entry.isFile() || !isSessionFile(entry.name)) continue;
      const path = join(root, dir.name, entry.name);
      const mtimeMs = mayFail(() => statSync(path).mtimeMs);
      // Vanished between readdir and stat — skip it.
      if (!mtimeMs.ok) continue;
      out.push({
        id: basename(entry.name, SESSION_EXT),
        path,
        mtimeMs: mtimeMs.data,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
};

// Session ids come from URL path params, so refuse anything that could
// traverse out of the projects root before scanning for it.
const safeId = (id: string): boolean =>
  id !== "" && !id.startsWith(".") && !id.includes("/") && !id.includes("\\");

const findTranscript = (root: string, id: string): string | undefined => {
  if (!safeId(id)) return undefined;
  for (const file of listSessionFiles(root))
    if (file.id === id) return file.path;
  return undefined;
};

// The fork writer's outcome: the new transcript's path, or why the copy
// never happened (the source transcript is missing, or the cutoff is
// past its last message).
type ForkTranscriptResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "missing" | "range" };

// A line becomes a transcript message on exactly the conditions
// appendMessage applies: a main-chain (non-sidechain) user or assistant
// record.
const isMessageLine = (parsed: Record<string, unknown>): boolean =>
  (parsed.type === "user" || parsed.type === "assistant") &&
  parsed.isSidechain !== true;

// How many leading lines a fork keeps: all of them for a whole-history
// copy, otherwise up to and including the cutoff message's line, counting
// messages exactly the way appendMessage does. `undefined` when the
// cutoff is past the last message.
const keptLineCount = (
  lines: readonly string[],
  cutoff: number | null,
): number | undefined => {
  if (cutoff === null) return lines.length;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    if (parsed !== undefined && isMessageLine(parsed)) {
      if (seen === cutoff) return i + 1;
      seen++;
    }
  }
  return undefined;
};

const rebindLine = (line: string, forkId: string): string => {
  const parsed = parseLine(line);
  if (parsed === undefined) return line;
  parsed.sessionId = forkId;
  return JSON.stringify(parsed);
};

// Copies a transcript under a new session id, keeping the line prefix up
// to the cutoff message. uuid/parentUuid chains stay intact (a prefix cut
// never breaks a backwards-pointing chain), and the new file lands beside
// the source in the same project directory so a resumed fork resolves the
// same working dir. The source file is never written. Verified against
// claude 2.1.289: `claude --resume <id>` loads a hand-forged transcript
// exactly like this one.
const forkTranscript = (
  root: string,
  sourceId: string,
  forkId: string,
  cutoff: number | null,
): ForkTranscriptResult => {
  const sourcePath = findTranscript(root, sourceId);
  if (sourcePath === undefined) return { ok: false, reason: "missing" };
  // The BOM strip mirrors parseTranscriptText so the first line cuts and
  // rewrites the same way it parses.
  const lines = readTranscriptText(sourcePath)
    .replace(/^\uFEFF/, "")
    .split("\n");

  const kept = keptLineCount(lines, cutoff);
  if (kept === undefined) return { ok: false, reason: "range" };

  const rewritten = lines
    .slice(0, kept)
    .map((line) => rebindLine(line, forkId));
  // A final newline leaves one trailing empty element behind; the fork
  // ends with exactly one terminator.
  while (rewritten.length > 0 && rewritten[rewritten.length - 1] === "")
    rewritten.pop();
  const path = join(dirname(sourcePath), `${forkId}${SESSION_EXT}`);
  writeFileSync(
    path,
    rewritten.length === 0 ? "" : `${rewritten.join("\n")}\n`,
  );
  return { ok: true, path };
};

// Best-effort shred before permanent removal: zero the bytes in place
// (unlinking alone only forgets content), evict the cached parse, then
// remove the file. No userspace writer can defeat SSD wear-leveling or
// CoW snapshots — every step may fail so long as the file ends up gone.
const ZERO_CHUNK_BYTES = 64 * 1024;

const overwriteWithZeros = (path: string): void => {
  const size = statSync(path).size;
  const fd = openSync(path, "r+");
  try {
    const chunk = Buffer.alloc(ZERO_CHUNK_BYTES);
    let remaining = size;
    while (remaining > 0) {
      const written = writeSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, remaining),
      );
      if (written <= 0) break;
      remaining -= written;
    }
  } finally {
    closeSync(fd);
  }
};

const deleteTranscript = (root: string, id: string): void => {
  const path = findTranscript(root, id);
  if (path === undefined) return;
  try {
    overwriteWithZeros(path);
  } catch {
    // Vanished or unreadable — nothing left to shred.
  }
  parseCache.delete(path);
  rmSync(path, { force: true });
};

export type { SessionFile, Transcript };
export {
  deleteTranscript,
  findTranscript,
  forkTranscript,
  listSessionFiles,
  parseTranscriptFile,
  readTranscriptText,
};
