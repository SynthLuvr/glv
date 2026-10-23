type SessionRow = {
  id: string;
  // The agent a namespaced id belongs to ("goose", "claude"). Set by the
  // composite store when several agents share one server; absent on
  // single-flavor rows, where the id is native.
  agent?: string;
  name: string;
  // goose's schema stores 0/1 with NULL for legacy rows; claude derives 0/1.
  user_set_name: number | null;
  description: string;
  session_type: string;
  working_dir: string;
  created_at: string;
  updated_at: string;
  total_tokens: number | null;
  provider_name: string | null;
  // The model the session ran with, as the flavor's store records it;
  // null when the store has none — the header omits the chip then.
  model: string | null;
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

// `type` narrows listing to a session kind the store understands ("user",
// "hidden", ...); stores with a single session kind ignore it. `offset`
// skips that many rows of the filtered, newest-first order (pagination).
// The optional restrictions (#344) all narrow before that window, so
// limit/offset page the filtered order: `workingDirPrefix` keeps only
// sessions under one directory, `ids` keeps only the named sessions, and
// `agent` narrows the composite store's merged listing to one agent's
// child store (a single-agent store never sees it — every row it lists
// is that one agent's).
type SessionFilter = {
  type: string;
  limit: number;
  includeArchived: boolean;
  offset?: number;
  workingDirPrefix?: string;
  ids?: ReadonlySet<string>;
  agent?: string;
};

// The working_dir restriction's match rule (#344): a session is under the
// prefix when its working_dir equals the prefix or sits one or more
// segments deeper — the boundary is a path separator, so "/repo" keeps
// "/repo" and "/repo/sub" but not the sibling "/repo-2". Both separator
// spellings count, so Windows-stored rows filter like POSIX ones. The
// goose store mirrors this rule in SQL (its listing never runs JS per
// row); this spelling serves the claude store and anything else that
// needs the same answer against a row it already holds.
const isUnderWorkingDirPrefix = (dir: string, prefix: string): boolean =>
  dir === prefix ||
  dir.startsWith(`${prefix}/`) ||
  dir.startsWith(`${prefix}\\`);

// The name a fork of `sourceName` carries — user-set, so it survives the
// agent's own retitling. A nameless source forks to a plain "Fork".
const forkSessionName = (sourceName: string): string => {
  const base = sourceName.trim();
  return base === "" ? "Fork" : `${base} (fork)`;
};

// What a store's forkSession returns: the new session's row on success,
// an HTTP-flavoured failure otherwise (404: source gone; 422: cutoff
// outside the transcript; 500: the copy could not be read back).
type ForkResult =
  | { readonly ok: true; readonly row: SessionRow }
  | { readonly ok: false; readonly status: number; readonly error: string };

// The shared session model and the storage boundary between the glv
// core and each flavor: each flavor implements `SessionStore` over its
// own storage (goose: its SQLite sessions database; claude: transcript
// JSONL plus a viewer-owned meta sidecar); core code consumes this
// interface only. Browsing is
// read-only against agent-owned data; the only mutations are viewer-managed
// (rename, archive, permanent delete, fork — a pure copy the source
// survives untouched) and route through the same interface.
type SessionStore = {
  readonly listSessions: (filter: SessionFilter) => SessionRow[];
  readonly getSession: (id: string) => SessionRow | undefined;
  readonly listMessages: (sessionId: string) => MessageRow[];
  readonly archiveSessions: (ids: string[]) => void;
  readonly renameSession: (id: string, rawName: string) => void;
  // Unlike archive: every record of the session is destroyed, not hidden.
  readonly deleteSessions: (ids: string[]) => void;
  // Copies the session's persisted state under a fresh id, keeping only
  // the messages up to `cutoff` — the index of the last message to
  // keep, in listMessages order; null keeps the whole history. The
  // source is never modified.
  readonly forkSession: (id: string, cutoff: number | null) => ForkResult;
  readonly firstPromptSessionName: (ids: string[]) => string | undefined;
  readonly prCandidateIds: (ids: string[]) => Set<string>;
};

export type { ForkResult, MessageRow, SessionFilter, SessionRow, SessionStore };
export { forkSessionName, isUnderWorkingDirPrefix };
