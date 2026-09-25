import type { DatabaseSync } from "node:sqlite";
import type { AuthService } from "../auth/service.js";
import type { AgentDispatchLauncher } from "../composite-launcher.js";
import type { GitRunner } from "../git.js";
import type { SessionLauncher } from "../launch.js";
import type { ModelSource } from "../models.js";
import type { CommandRunner } from "../pr-state.js";
import type { FlavorProfile } from "../profile.js";
import type { Runner } from "../runner/index.js";
import type { AgentInvocation } from "../runner/types.js";
import type { SessionFilter, SessionStore } from "../sessions.js";
import type { AssetBundle } from "./bundle.js";

const VIEWER_FILTER: SessionFilter = {
  type: "user",
  limit: 100,
  includeArchived: false,
};

// One agent the server serves: its profile, its (child) store and
// launcher, the argv builder its follow-up runs enqueue through, and
// its optional model picker. Everything agent-specific a route needs
// resolves through one of these.
type AgentRuntime = {
  readonly id: string;
  readonly profile: FlavorProfile;
  /** The flavor's store over native ids (the composite prefixes). */
  readonly store: SessionStore;
  /** The flavor's launcher; ids at this boundary are namespaced. */
  readonly launcher: SessionLauncher;
  /** The argv builder for follow-up prompts: registry keys carry the
   * namespace, the binary receives native ids. */
  readonly invocation: AgentInvocation;
  readonly models: ModelSource | undefined;
};

type ServerOptions = {
  /** Every agent this server serves, in picker order. Never empty. */
  agents: AgentRuntime[];
  /** The dist/<flavor> directory the asset bundle reads. */
  assetsFlavor: string;
  /** Viewer-owned data directory name (uploads/temp root). */
  dataDirName: string;
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
  // The composite namespaces every id by its agent; a single-agent
  // server is a composite of one.
  readonly sessions: SessionStore;
  // New-session strategy, dispatching to the agent a request names.
  readonly launcher: AgentDispatchLauncher;
  readonly runner: Runner;
  // The agent registry, in picker order.
  readonly agents: readonly AgentRuntime[];
  // Resolves the runtime a session id belongs to: by id prefix when
  // several agents are served, the sole agent otherwise.
  readonly agentOf: (id: string) => AgentRuntime | undefined;
  // The default agent for requests that name none (cron rows from
  // before the agent column, single-agent servers).
  readonly defaultAgent: AgentRuntime;
  // "goose" or "goose + claude" — user-facing copy naming every agent.
  readonly agentNames: string;
  // Viewer-owned data directory name ("glv"): uploads and temp dirs
  // live under it.
  readonly dataDirName: string;
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
  readonly cronDb: DatabaseSync | undefined;
  readonly onCronJobsChange: (() => void) | undefined;
  readonly createLocks: Map<string, Promise<void>>;
  readonly assets: AssetBundle;
};

export type { AgentRuntime, ServerContext, ServerOptions };
export { VIEWER_FILTER };
