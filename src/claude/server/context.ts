import type { DatabaseSync } from "node:sqlite";
import type { AuthService } from "../auth/service.js";
import type { SessionFilter, SessionStore } from "../db.js";
import type { GitRunner } from "../git.js";
import type { CommandRunner } from "../pr-state.js";
import type { Runner } from "../runner/index.js";
import type { AssetBundle } from "./bundle.js";

const VIEWER_FILTER: SessionFilter = {
  limit: 100,
  includeArchived: false,
};

const SESSION_TIMEOUT_ERROR =
  "claude did not create a session in time. Is the claude binary available?";

type ServerOptions = {
  tailPollMs?: number;
  /** Bounds poll iterations so tests can drain the stream. */
  maxTailPolls?: number;
  pollTimeoutMs?: number;
  /** Poll interval (ms) for the global status feed. */
  statusPollMs?: number;
  /** Bounds status-feed poll iterations so tests can drain the stream. */
  maxStatusPolls?: number;
  listDirs?: () => string[];
  auth?: AuthService;
  prompts?: DatabaseSync;
  groups?: DatabaseSync;
  rpName?: string;
  rpIdOverride?: string;
  /** Subprocess runner for `gh pr view`; tests inject a fake. */
  runPrState?: CommandRunner;
  /** Subprocess runner for local `git` queries; tests inject a fake. */
  runGit?: GitRunner;
};

// Everything a route handler needs, threaded in explicitly so route modules
// stay free of shared mutable closure state.
type ServerContext = {
  // claude's transcript files are only ever read — the store never writes
  // to a file a live claude session is appending to; archive/rename
  // mutations go through the viewer-owned meta sidecar inside `store`.
  readonly store: SessionStore;
  readonly runner: Runner;
  readonly auth: AuthService | undefined;
  readonly prompts: DatabaseSync | undefined;
  readonly groups: DatabaseSync | undefined;
  readonly rpName: string | undefined;
  readonly rpIdOverride: string | undefined;
  readonly listDirs: () => string[];
  readonly tailPollMs: number;
  readonly maxTailPolls: number;
  readonly pollTimeoutMs: number;
  readonly statusPollMs: number;
  readonly maxStatusPolls: number;
  readonly runPrState: CommandRunner | undefined;
  readonly runGit: GitRunner | undefined;
  readonly createLocks: Map<string, Promise<void>>;
  readonly assets: AssetBundle;
};

export type { ServerContext, ServerOptions };
export { SESSION_TIMEOUT_ERROR, VIEWER_FILTER };
