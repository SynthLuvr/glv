import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { truncate } from "../glv/format/text.js";
import {
  archiveSessions as archiveMeta,
  deleteSessions as deleteMeta,
  getMeta,
  listMeta,
  type MetaRow,
  renameSession as renameMeta,
} from "../glv/session-meta.js";
import type {
  ForkResult,
  MessageRow,
  SessionFilter,
  SessionRow,
  SessionStore,
} from "../glv/sessions.js";
import { forkSessionName, isUnderWorkingDirPrefix } from "../glv/sessions.js";
import {
  deleteTranscript,
  findTranscript,
  forkTranscript,
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
  model: transcript.model ?? null,
  archived_at: meta?.archived_at ?? null,
});

const listSessions = (
  store: ClaudeStoreData,
  filter: SessionFilter,
): SessionRow[] => {
  const meta = listMeta(store.meta);
  const out: SessionRow[] = [];
  let skipped = 0;
  const offset = filter.offset ?? 0;
  for (const file of listSessionFiles(store.root)) {
    if (out.length >= filter.limit) break;
    const metaRow = meta.get(file.id);
    const archived = metaRow !== undefined && metaRow.archived_at !== null;
    if (archived && !filter.includeArchived) continue;
    // The id restriction (#344) skips before the transcript parse —
    // walking the file list is cheap, parsing every transcript is not.
    if (filter.ids !== undefined && !filter.ids.has(file.id)) continue;
    const row = sessionRow(file, metaRow, parseTranscriptFile(file.path));
    // working_dir lives on the transcript, so the prefix check needs the
    // parsed row — but still lands before the window bookkeeping below.
    if (
      filter.workingDirPrefix !== undefined &&
      !isUnderWorkingDirPrefix(row.working_dir, filter.workingDirPrefix)
    )
      continue;
    // Offset applies to the filtered order, mirroring SQL semantics:
    // archived and filtered-out rows are excluded first, then the
    // window skips forward.
    if (skipped < offset) {
      skipped++;
      continue;
    }
    out.push(row);
  }
  return out;
};

const getSession = (
  store: ClaudeStoreData,
  id: string,
): SessionRow | undefined => {
  const path = findTranscript(store.root, id);
  if (path === undefined) return undefined;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Deleted between the listing above and this stat — the same race
    // listSessionFiles guards against. Report the session as gone rather
    // than surfacing a 500.
    return undefined;
  }
  return sessionRow(
    { id, path, mtimeMs },
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

// Forks a claude session by writing a second transcript: the line prefix
// up to the cutoff rewritten under a fresh session id (claude --resume
// accepts it — verified against 2.1.289), with the fork name mirrored
// into the viewer-owned meta sidecar. The source transcript is only ever
// read.
const forkSession = (
  store: ClaudeStoreData,
  sourceId: string,
  cutoff: number | null,
): ForkResult => {
  const source = getSession(store, sourceId);
  if (source === undefined)
    return { ok: false, status: 404, error: `No session ${sourceId}.` };
  const forkId = randomUUID();
  const result = forkTranscript(store.root, sourceId, forkId, cutoff);
  if (!result.ok)
    return result.reason === "missing"
      ? { ok: false, status: 404, error: `No session ${sourceId}.` }
      : {
          ok: false,
          status: 422,
          error: `Cutoff ${cutoff} is past the end of the session's transcript.`,
        };
  renameMeta(store.meta, forkId, forkSessionName(source.name));
  const row = getSession(store, forkId);
  return row === undefined
    ? {
        ok: false,
        status: 500,
        error: "The forked session could not be read back.",
      }
    : { ok: true, row };
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
    deleteSessions: (ids) => {
      // Shred the transcripts first, then drop the viewer's sidecar rows.
      for (const id of ids) deleteTranscript(store.root, id);
      deleteMeta(store.meta, ids);
    },
    forkSession: (id, cutoff) => forkSession(store, id, cutoff),
    firstPromptSessionName: (ids) => firstPromptSessionName(store, ids),
    prCandidateIds: (ids) => prCandidateIds(store, ids),
  };
};

export { createSessionStore };
