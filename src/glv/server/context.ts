import type { DatabaseSync } from "node:sqlite";
import type { AuthService } from "../auth/service.js";
import type { GitRunner } from "../git.js";
import type { SessionLauncher } from "../launch.js";
import type { ModelSource } from "../models.js";
import type { CommandRunner } from "../pr-state.js";
import type { FlavorProfile } from "../profile.js";
import type { Runner } from "../runner/index.js";
import type { SessionFilter, SessionStore } from "../sessions.js";
import type { AssetBundle } from "./bundle.js";

const VIEWER_FILTER: SessionFilter = {
  type: "user",
  limit: 100,
  includeArchived: false,
};

type ServerOptions = {
  profile: FlavorProfile;
  tailPollMs?: number;
  /** Bounds poll iterations so tests can drain the stream. */
  maxTailPolls?: number;
  pollTimeoutMs?: number;
  /** Poll interval (ms) for the global status feed. */
  statusPollMs?: number;
  /** Bounds status-feed poll iterations so tests can drain the feed. */
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
  /** Model picker for the New Session form; undefined hides the field. */
  models?: ModelSource;
  /**
   * The cron database: job rows (the schedule the UI manages) and the
   * job-started-session tags the sidebar badges read. Optional so
   * app-less tests work.
   */
  cronDb?: DatabaseSync;
  /**
   * Nudges the cron scheduler to re-read the job table; the UI routes
   * call it after every mutation so edits apply instantly.
   */
  onCronJobsChange?: () => void;
};

// Everything a route handler needs, threaded in explicitly so route modules
// stay free of shared mutable closure state.
type ServerContext = {
  // Storage boundary: browsing is read-only against agent-owned data;
  // viewer-managed rename/archive mutations route through the same store.
  readonly sessions: SessionStore;
  // New-session strategy for this flavor (see glv/launch.ts).
  readonly launcher: SessionLauncher;
  readonly runner: Runner;
  readonly profile: FlavorProfile;
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
  readonly models: ModelSource | undefined;
  readonly cronDb: DatabaseSync | undefined;
  readonly onCronJobsChange: (() => void) | undefined;
  readonly createLocks: Map<string, Promise<void>>;
  readonly assets: AssetBundle;
};

export type { ServerContext, ServerOptions };
export { VIEWER_FILTER };
