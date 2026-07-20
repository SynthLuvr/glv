import type { DatabaseSync } from "node:sqlite";
import type { AuthService } from "../auth/service.js";
import type { SessionFilter } from "../db.js";
import type { CloneJob, GhClient } from "../gh.js";
import type { GitRunner } from "../git.js";
import type { CommandRunner } from "../pr.js";
import type { Runner } from "../runner/index.js";
import type { AssetBundle } from "./bundle.js";

const VIEWER_FILTER: SessionFilter = {
  type: "user",
  limit: 100,
  includeArchived: false,
};

const SESSION_TIMEOUT_ERROR =
  "goose did not create a session in time. Is the goose binary available?";

type ServerOptions = {
  tailPollMs?: number;
  /** Bounds poll iterations so tests can drain the stream. */
  maxTailPolls?: number;
  pollTimeoutMs?: number;
  /** Poll interval (ms) for the global status feed. */
  statusPollMs?: number;
  /** Bounds status-feed poll iterations so tests can drain the stream. */
  maxStatusPolls?: number;
  /** Retention (ms) after which an unclaimed clone job is swept. */
  cloneJobTtlMs?: number;
  /** Sweep cadence (ms); 0 disables it. */
  cloneJobSweepMs?: number;
  listDirs?: () => string[];
  gh?: GhClient;
  auth?: AuthService;
  prompts?: DatabaseSync;
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
  readonly db: DatabaseSync;
  readonly runner: Runner;
  readonly gh: GhClient;
  readonly auth: AuthService | undefined;
  readonly prompts: DatabaseSync | undefined;
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
  readonly cloneJobs: Map<string, CloneJob>;
  readonly cloneJobTtlMs: number;
  readonly cloneJobSweepMs: number;
  readonly createLocks: Map<string, Promise<void>>;
  readonly assets: AssetBundle;
};

export type { AssetBundle, ServerContext, ServerOptions };
export { SESSION_TIMEOUT_ERROR, VIEWER_FILTER };
