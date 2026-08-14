import { statSync } from "node:fs";
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
const deriveName = (
  meta: MetaRow | undefined,
  transcript: Transcript,
): string => {
  if (meta !== undefined && meta.user_set_name === 1) return meta.name;
  if (transcript.aiTitle !== undefined && transcript.aiTitle !== "")
    return transcript.aiTitle;
  if (transcript.firstUserText === undefined) return "";
  return truncate(
    transcript.firstUserText.trim().replace(/\s+/g, " "),
    DERIVED_NAME_MAX,
  );
};

const sessionRow = (
  file: SessionFile,
  meta: MetaRow | undefined,
  transcript: Transcript,
): SessionRow => ({
  id: file.id,
  name: deriveName(meta, transcript),
  user_set_name: meta !== undefined && meta.user_set_name === 1 ? 1 : 0,
  description: "",
  session_type: "user",
  // Transcripts carry the true working dir on their lines. When a foreign
  // file has none, "" is reported rather than guessing from the dashed
  // directory name — a wrong path is worse than none.
  working_dir: transcript.cwd ?? "",
  created_at: transcript.firstTimestamp ?? isoFromMs(file.mtimeMs),
  updated_at: transcript.lastTimestamp ?? isoFromMs(file.mtimeMs),
  total_tokens: transcript.tokens,
  provider_name:
    transcript.model ?? (transcript.messages.length > 0 ? "claude" : null),
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
    const metaRow = meta.get(file.id);
    const archived = metaRow !== undefined && metaRow.archived_at !== null;
    if (archived && !filter.includeArchived) continue;
    out.push(sessionRow(file, metaRow, parseTranscriptFile(file.path)));
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
  return parseTranscriptFile(path).messages.map((message) => ({
    message_id: message.uuid,
    session_id: sessionId,
    role: message.role,
    content_json: JSON.stringify(message.items),
    created_timestamp: message.createdTimestamp,
    timestamp: message.timestamp,
  }));
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
    const transcript = parseTranscriptFile(path);
    if (transcript.firstUserTimestamp === undefined) continue;
    if (transcript.firstUserTimestamp < bestTs) {
      bestTs = transcript.firstUserTimestamp;
      bestId = id;
    }
  }
  return bestId === undefined ? undefined : getSession(store, bestId)?.name;
};

const archiveSessions = (store: SessionStore, ids: string[]): void =>
  archiveMeta(store.meta, ids);

const renameSession = (
  store: SessionStore,
  id: string,
  rawName: string,
): void => renameMeta(store.meta, id, rawName);

export type { MessageRow, SessionFilter, SessionRow, SessionStore };
export {
  archiveSessions,
  firstPromptSessionName,
  getSession,
  listMessages,
  listSessions,
  prCandidateIds,
  renameSession,
};
