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
type SessionFilter = {
  type: string;
  limit: number;
  includeArchived: boolean;
  offset?: number;
};

// The shared session model and the storage boundary between the glv
// core and each flavor: each flavor implements `SessionStore` over its
// own storage (goose: its SQLite sessions database; claude: transcript
// JSONL plus a viewer-owned meta sidecar); core code consumes this
// interface only. Browsing is
// read-only against agent-owned data; the only mutations are viewer-managed
// (rename, archive, permanent delete) and route through the same interface.
type SessionStore = {
  readonly listSessions: (filter: SessionFilter) => SessionRow[];
  readonly getSession: (id: string) => SessionRow | undefined;
  readonly listMessages: (sessionId: string) => MessageRow[];
  readonly archiveSessions: (ids: string[]) => void;
  readonly renameSession: (id: string, rawName: string) => void;
  // Unlike archive: every record of the session is destroyed, not hidden.
  readonly deleteSessions: (ids: string[]) => void;
  readonly firstPromptSessionName: (ids: string[]) => string | undefined;
  readonly prCandidateIds: (ids: string[]) => Set<string>;
};

export type { MessageRow, SessionFilter, SessionRow, SessionStore };
