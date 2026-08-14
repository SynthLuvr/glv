import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { truncate } from "./format/text.js";
import {
  archiveSessions as archiveMeta,
  getMeta,
  listMeta,
  type MetaRow,
  renameSession as renameMeta,
} from "./store/meta.js";
import {
  findTranscript,
  listSessionFiles,
  parseTranscriptFile,
  readTranscriptText,
  type SessionFile,
  type Transcript,
} from "./store/transcript.js";
import { encodeWorkingDir } from "./store/working-dir.js";

// The session store glv reads: claude Code's own transcript directory
// (append-only JSONL the claude CLI writes as it runs) plus glv's
// rename/archive sidecar. Browsing never writes to claude's files; the only
// mutations are viewer-managed metadata routed through the sidecar, so it is
// always safe while claude is running.
type SessionStore = {
  readonly root: string;
  readonly meta: DatabaseSync;
};

type SessionRow = {
  id: string;
  name: string;
  user_set_name: number;
  description: string;
  session_type: string;
  working_dir: string;
  created_at: string;
  updated_at: string;
  total_tokens: number | null;
  provider_name: string | null;
  archived_at: string | null;
};

type MessageRow = {
  message_id: string | null;
  session_id: string;
  role: string;
  content_json: string;
  created_timestamp: number;
  timestamp: string;
};

type SessionFilter = {
  limit: number;
  includeArchived: boolean;
};

const DERIVED_NAME_MAX = 60;

const isoFromMs = (ms: number): string => new Date(ms).toISOString();

// Naming precedence: a viewer-set name wins, then claude's own ai-title,
// then a truncation of the first user prompt; empty when nothing is known.
const deriveName = (meta: MetaRow | undefined, t: Transcript): string => {
  if (meta !== undefined && meta.user_set_name === 1) return meta.name;
  if (t.aiTitle !== undefined && t.aiTitle !== "") return t.aiTitle;
  if (t.firstUserText === undefined) return "";
  return truncate(
    t.firstUserText.trim().replace(/\s+/g, " "),
    DERIVED_NAME_MAX,
  );
};

const sessionRow = (
  file: SessionFile,
  meta: MetaRow | undefined,
  t: Transcript,
): SessionRow => ({
  id: file.id,
  name: deriveName(meta, t),
  user_set_name: meta !== undefined && meta.user_set_name === 1 ? 1 : 0,
  description: "",
  session_type: "user",
  // Transcripts carry the true working dir on their lines. When a foreign
  // file has none, "" is reported rather than guessing from the dashed
  // directory name — a wrong path is worse than none.
  working_dir: t.cwd ?? "",
  created_at: t.firstTimestamp ?? isoFromMs(file.mtimeMs),
  updated_at: t.lastTimestamp ?? isoFromMs(file.mtimeMs),
  total_tokens: t.tokens,
  provider_name: t.model ?? (t.messages.length > 0 ? "claude" : null),
  archived_at: meta?.archived_at ?? null,
});

const listSessions = (
  store: SessionStore,
  filter: SessionFilter,
): SessionRow[] => {
  const meta = listMeta(store.meta);
  const out: SessionRow[] = [];
  for (const file of listSessionFiles(store.root)) {
    if (out.length >= filter.limit) break;
    const m = meta.get(file.id);
    const archived = m !== undefined && m.archived_at !== null;
    if (archived && !filter.includeArchived) continue;
    out.push(sessionRow(file, m, parseTranscriptFile(file.path)));
  }
  return out;
};

const getSession = (
  store: SessionStore,
  id: string,
): SessionRow | undefined => {
  const path = findTranscript(store.root, id);
  if (path === undefined) return undefined;
  return sessionRow(
    { id, path, mtimeMs: statSync(path).mtimeMs },
    getMeta(store.meta, id),
    parseTranscriptFile(path),
  );
};

const listMessages = (store: SessionStore, sessionId: string): MessageRow[] => {
  const path = findTranscript(store.root, sessionId);
  if (path === undefined) return [];
  return parseTranscriptFile(path).messages.map((m) => ({
    message_id: m.uuid,
    session_id: sessionId,
    role: m.role,
    content_json: JSON.stringify(m.items),
    created_timestamp: m.createdTimestamp,
    timestamp: m.timestamp,
  }));
};

// Lets callers scope session lookups to one working directory (used by
// tooling and tests; the new-session flow itself now pre-assigns ids).
const sessionIdsInDir = (store: SessionStore, workingDir: string): string[] => {
  let entries;
  try {
    entries = readdirSync(join(store.root, encodeWorkingDir(workingDir)), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) => e.isFile() && !e.name.startsWith(".") && e.name.endsWith(".jsonl"),
    )
    .map((e) => basename(e.name, ".jsonl"));
};

// Cheap pre-filter for sidebar PR detection: only transcripts whose raw
// text references a GitHub pull URL can resolve to a PR, so callers skip
// parsing messages for the rest.
const prCandidateIds = (store: SessionStore, ids: string[]): Set<string> => {
  const out = new Set<string>();
  for (const id of ids) {
    const path = findTranscript(store.root, id);
    if (path === undefined) continue;
    if (readTranscriptText(path).includes("/pull/")) out.add(id);
  }
  return out;
};

// Used to name a freshly created group after its founding session — the one
// whose first user prompt came earliest. `undefined` when none of the
// sessions have a user message yet.
const firstPromptSessionName = (
  store: SessionStore,
  ids: string[],
): string | undefined => {
  let bestId: string | undefined;
  let bestTs = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const path = findTranscript(store.root, id);
    if (path === undefined) continue;
    const t = parseTranscriptFile(path);
    if (t.firstUserTimestamp === undefined) continue;
    if (t.firstUserTimestamp < bestTs) {
      bestTs = t.firstUserTimestamp;
      bestId = id;
    }
  }
  return bestId === undefined ? undefined : getSession(store, bestId)?.name;
};

const archiveSessions = (store: SessionStore, ids: string[]): void => {
  archiveMeta(store.meta, ids);
};

// A blank name clears the user-set flag so derived naming takes over again.
const renameSession = (
  store: SessionStore,
  id: string,
  rawName: string,
): void => {
  renameMeta(store.meta, id, rawName);
};

export type { MessageRow, SessionFilter, SessionRow, SessionStore };
export {
  archiveSessions,
  firstPromptSessionName,
  getSession,
  listMessages,
  listSessions,
  prCandidateIds,
  renameSession,
  sessionIdsInDir,
};
