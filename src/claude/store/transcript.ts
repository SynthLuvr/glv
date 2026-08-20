import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    message.model !== ""
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
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return emptyEntry();
  }
  const hit = parseCache.get(path);
  if (
    hit !== undefined &&
    hit.mtimeMs === stat.mtimeMs &&
    hit.size === stat.size
  )
    return hit;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyEntry();
  }
  const entry: CacheEntry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    text,
    transcript: parseTranscriptText(text),
  };
  if (parseCache.size >= MAX_CACHE_ENTRIES) parseCache.clear();
  parseCache.set(path, entry);
  return entry;
};

const parseTranscriptFile = (path: string): Transcript =>
  readTranscript(path).transcript;

// Raw text via the same cache, so PR-candidate scans avoid re-reading too.
const readTranscriptText = (path: string): string => readTranscript(path).text;

// All transcript files across project directories, newest first — the file
// mtime is claude's own "updated_at", so the sort matches the sidebar order.
const listSessionFiles = (root: string): SessionFile[] => {
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SessionFile[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
    let entries;
    try {
      entries = readdirSync(join(root, dir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isSessionFile(entry.name)) continue;
      const path = join(root, dir.name, entry.name);
      try {
        out.push({
          id: basename(entry.name, SESSION_EXT),
          path,
          mtimeMs: statSync(path).mtimeMs,
        });
      } catch {
        // Vanished between readdir and stat — skip it.
      }
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

export type { SessionFile, Transcript };
export {
  findTranscript,
  listSessionFiles,
  parseTranscriptFile,
  readTranscriptText,
};
