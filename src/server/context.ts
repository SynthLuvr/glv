import type { DatabaseSync } from "node:sqlite";
import type { AuthService } from "../auth/service.js";
import type { SessionFilter } from "../db.js";
import type { CloneJob, GhClient } from "../gh.js";
import type { CommandRunner } from "../pr.js";
import type { Runner } from "../runner/index.js";

type AppEnv = { Variables: { runner: Runner } };

const VIEWER_FILTER: SessionFilter = {
  type: "user",
  limit: 100,
  includeArchived: false,
};

const SESSION_TIMEOUT_ERROR =
  "goose did not create a session in time. Is the goose binary available?";

// Built once when the app starts (after the serve command builds them) and
// shared with the asset routes. htmx is resolved from node_modules; the rest
// live in dist/.
type AssetBundle = {
  readonly htmx: string;
  readonly appCss: string;
  readonly sidebar: string;
  readonly stream: string;
  readonly theme: string;
  readonly markdownCopy: string;
  readonly rename: string;
  readonly sourcePicker: string;
  readonly passkey: string;
};

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
  gh?: GhClient;
  auth?: AuthService;
  rpName?: string;
  rpIdOverride?: string;
  /** Subprocess runner for `gh pr view`; tests inject a fake. */
  runPrState?: CommandRunner;
};

// Everything a route handler needs, threaded in explicitly so route modules
// stay free of shared mutable closure state.
type ServerContext = {
  readonly db: DatabaseSync;
  readonly runner: Runner;
  readonly gh: GhClient;
  readonly auth: AuthService | undefined;
  readonly rpName: string | undefined;
  readonly rpIdOverride: string | undefined;
  readonly listDirs: () => string[];
  readonly tailPollMs: number;
  readonly maxTailPolls: number;
  readonly pollTimeoutMs: number;
  readonly statusPollMs: number;
  readonly maxStatusPolls: number;
  readonly runPrState: CommandRunner | undefined;
  readonly cloneJobs: Map<string, CloneJob>;
  // Serializes the snapshot-enqueue-poll-rekey sequence per working dir so two
  // concurrent new-session submissions for the same dir can't race on the same
  // discovered session id (orphaning a handle and leaking a goose process).
  readonly createLocks: Map<string, Promise<void>>;
  readonly assets: AssetBundle;
};

export type { AppEnv, AssetBundle, ServerContext, ServerOptions };
export { SESSION_TIMEOUT_ERROR, VIEWER_FILTER };
