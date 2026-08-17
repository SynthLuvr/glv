import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  archiveSessions as archiveMeta,
  getMeta,
  listMeta,
  type MetaRow,
  renameSession as renameMeta,
} from "../glv/session-meta.js";
import type {
  MessageRow,
  SessionFilter,
  SessionRow,
  SessionStore,
} from "../glv/sessions.js";
import { truncate } from "./format/text.js";
import {
  findTranscript,
  listSessionFiles,
  parseTranscriptFile,
  readTranscriptText,
  type SessionFile,
  type Transcript,
} from "./store/transcript.js";

// The data glv reads for the claude flavor: claude Code's own transcript
// directory (append-only JSONL the claude CLI writes as it runs) plus glv's
// rename/archive sidecar. Browsing never writes to claude's files; the only
// mutations are viewer-managed metadata routed through the sidecar, so it is
// always safe while claude is running.
type ClaudeStoreData = {
  readonly root: string;
  readonly meta: DatabaseSync;
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
  store: ClaudeStoreData,
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
  store: ClaudeStoreData,
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

const listMessages = (
  store: ClaudeStoreData,
  sessionId: string,
): MessageRow[] => {
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
const prCandidateIds = (store: ClaudeStoreData, ids: string[]): Set<string> => {
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
  store: ClaudeStoreData,
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

// The claude storage adapter: transcripts are only ever read; viewer-managed
// rename/archive metadata routes through the viewer-owned sidecar.
const createSessionStore = (root: string, meta: DatabaseSync): SessionStore => {
  const store: ClaudeStoreData = { root, meta };
  return {
    listSessions: (filter) => listSessions(store, filter),
    getSession: (id) => getSession(store, id),
    listMessages: (sessionId) => listMessages(store, sessionId),
    archiveSessions: (ids) => archiveMeta(store.meta, ids),
    renameSession: (id, rawName) => renameMeta(store.meta, id, rawName),
    firstPromptSessionName: (ids) => firstPromptSessionName(store, ids),
    prCandidateIds: (ids) => prCandidateIds(store, ids),
  };
};

export { createSessionStore };
