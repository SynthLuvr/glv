import { mkdirSync } from "node:fs";
import type { Socket } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openAuthDb } from "../auth/db.js";
import { makeAuthService } from "../auth/service.js";
import { buildAssets } from "../build.js";
import {
  type AgentDispatchLauncher,
  createCompositeLauncher,
} from "../composite-launcher.js";
import { createCompositeSessionStore } from "../composite-store.js";
import { startCronScheduler } from "../cron.js";
import {
  backfillCronAgents,
  deleteCronJob,
  listCronJobs,
  openCronDb,
  recordCronFire,
  watchCronJobs,
} from "../cron-jobs.js";
import { tagCronSession } from "../cron-sessions.js";
import { resolveDataPath } from "../db-path.js";
import { openGroupsDb } from "../groups/db.js";
import type { SessionLauncher } from "../launch.js";
import { setupLogging } from "../log.js";
import {
  decodeAgentModelValue,
  type ModelSelection,
  type ModelSource,
} from "../models.js";
import type { FlavorProfile } from "../profile.js";
import { openPromptsDb } from "../prompts/db.js";
import {
  createRunner,
  type Runner,
  type RunnerConfig,
  stopAll,
} from "../runner/index.js";
import type { AgentInvocation, RunHandle } from "../runner/types.js";
import type { AgentRuntime } from "../server/context.js";
import { createApp } from "../server/index.js";
import type { SessionStore } from "../sessions.js";
import {
  clearStopNotice,
  openStopNoticesDb,
  recordStopNotice,
} from "../stop-notices.js";
import type { EphemeralAsk } from "../suggestions/ask.js";
import { getSuggestionModel, openSuggestionsDb } from "../suggestions/db.js";
import { createSuggestionService } from "../suggestions/service.js";

// One agent's wiring as a serve caller provides it: the flavor adapters
// (store, launcher factory, argv builder, optional model picker) plus
// how to close the store on shutdown.
type AgentServeSpec = {
  readonly profile: FlavorProfile;
  readonly store: SessionStore;
  /**
   * The argv builder follow-up enqueues use — the prefixed view, which
   * turns namespaced runner keys into native ids in the agent's argv.
   * The launcher's own invocation stays raw and strips the prefix
   * itself, once.
   */
  readonly invocation: AgentInvocation;
  /** The agent's model picker; undefined hides the picker entirely. */
  readonly models: ModelSource | undefined;
  readonly makeLauncher: (runner: Runner) => SessionLauncher;
  readonly closeStore: () => void;
  /**
   * The behind-the-scenes ask this agent performs for suggested next
   * prompts: the argv that keeps the run session-free, plus any store
   * cleanup afterwards. Receives the glv-owned scratch directory asks
   * run in.
   */
  readonly ephemeralAsk: (scratchDir: string) => EphemeralAsk;
};

type ServeOpts = {
  port: number;
  /** One runner config: one concurrency pool across every agent. */
  runner: RunnerConfig;
  /** The agents to serve, in picker order; never empty. */
  agents: readonly AgentServeSpec[];
  /** Viewer-owned data directory name (uploads/temp root). */
  dataDirName: string;
  /** The dist/<name> directory the asset bundle reads. */
  assetsFlavor: string;
  authDbPath: string;
  promptsDbPath: string;
  groupsDbPath: string;
  cronDbPath: string;
  /** The suggested-next-prompts store (setting + rows, model pin). */
  suggestionsDbPath: string;
  stopNoticesDbPath: string;
  rpName: string;
  rpIdOverride?: string;
  debug: boolean;
};

// close() stops accepting connections; in-flight requests drain asynchronously.
type CloseableServer = {
  close: (callback?: (err?: Error) => void) => void;
};

// The pinned model an agent's suggestion asks use, read fresh from the
// suggestions store's settings row each ask (combined picker spelling,
// "<agent>:<model value>"). A pin that no longer resolves against the
// live catalogue warns once and falls back to the agent's own default
// (goose: whatever its config resolves) — a misconfiguration degrades,
// never breaks.
const makeSuggestionModelResolver = (
  runtimes: readonly AgentRuntime[],
  db: DatabaseSync,
): ((agentId: string) => ModelSelection | undefined) => {
  const warned = new Set<string>();
  return (agentId) => {
    const pinned = getSuggestionModel(db);
    if (pinned === undefined) return undefined;
    const pick = decodeAgentModelValue(pinned);
    if (pick.kind !== "pick" || pick.agent !== agentId) return undefined;
    if (pick.modelValue === "") return undefined;
    const runtime = runtimes.find((entry) => entry.id === agentId);
    const resolved = runtime?.models?.resolve(pick.modelValue);
    if (resolved === undefined && !warned.has(agentId)) {
      warned.add(agentId);
      console.warn(
        `suggestions: pinned model "${pinned}" does not resolve for ` +
          `agent ${agentId}; asking on its default`,
      );
    }
    return resolved;
  };
};

type ConnectionEmitter = {
  on: (event: "connection", listener: (socket: Socket) => void) => void;
};

const closeServer = (server: CloseableServer): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

// SSE streams never close on their own, so close()'s drain hangs while one is
// attached. Track every socket so shutdown can force them down and a single
// Ctrl+C exits instead of waiting for the browser to disconnect.
const trackConnections = (server: ConnectionEmitter): (() => void) => {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  return () => {
    for (const socket of sockets) socket.destroy();
  };
};

type ShutdownDeps = {
  server: CloseableServer;
  destroyConnections: () => void;
  stopCron: () => void;
  stopSuggestions: () => void;
  stopProcesses: () => void;
  closeDbs: () => void;
  exit: (code?: number) => void;
};

// A second interrupt while draining force-quits so a stuck request can't hang.
const createShutdown = (
  deps: ShutdownDeps,
): ((exitCode?: number) => Promise<void>) => {
  let draining = false;
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (draining) {
      deps.exit(exitCode === 0 ? 1 : exitCode);
      return;
    }
    draining = true;
    // Destroy sockets before draining; close() hangs on open SSE streams.
    deps.destroyConnections();
    await closeServer(deps.server);
    deps.stopCron();
    deps.stopSuggestions();
    deps.stopProcesses();
    deps.closeDbs();
    deps.exit(exitCode);
  };
  return shutdown;
};

type LifecycleEmitter = {
  on: (event: string, listener: (signal: unknown) => void) => unknown;
};

const registerShutdown = (
  shutdown: (exitCode?: number) => Promise<void>,
  emitter: LifecycleEmitter = process,
): void => {
  const onSignal = (): void => {
    void shutdown(0);
  };
  const onCrash = (err: unknown): void => {
    console.error(err);
    void shutdown(1);
  };
  emitter.on("SIGINT", onSignal);
  emitter.on("SIGTERM", onSignal);
  // Thrown errors/rejections would otherwise leak agent processes and DB
  // handles.
  emitter.on("uncaughtException", onCrash);
  emitter.on("unhandledRejection", onCrash);
};

const runServe = (opts: ServeOpts): void => {
  setupLogging(opts.debug);
  buildAssets(opts.assetsFlavor);
  // The stop-notices sidecar: provider-refusal notices (usage limit,
  // network outage — failures the agent announces on its own stream)
  // outlive the run handle so the session view can still explain the
  // stop after a reload or restart. Opened before the runner so the
  // observer never races it.
  const stopNotices = openStopNoticesDb(opts.stopNoticesDbPath);
  // A refusal is recorded for the session; a clean settle or manual stop
  // clears the row ("continue" resolves the outage). A plain crash —
  // error status, no stopNotice — keeps today's transient treatment:
  // the message exists only while the handle does.
  const syncStopNotice = (handle: RunHandle): void => {
    if (handle.stopNotice !== undefined)
      recordStopNotice(stopNotices, handle.sessionId, handle.stopNotice);
    else if (handle.status !== "error")
      clearStopNotice(stopNotices, handle.sessionId);
  };
  // Created here so shutdown can reap detached agent processes. One
  // runner, one concurrency pool, every agent.
  const runner = createRunner(opts.runner, undefined, syncStopNotice);
  const runtimes: AgentRuntime[] = opts.agents.map((spec) => ({
    id: spec.profile.id,
    profile: spec.profile,
    store: spec.store,
    launcher: spec.makeLauncher(runner),
    invocation: spec.invocation,
    models: spec.models,
  }));
  // The store and launcher the routes see: the composites namespace
  // every id that crosses the boundary by its agent (a composite of
  // one agent is the identity for single-agent serving).
  const sessions = createCompositeSessionStore(
    runtimes.map((runtime) => ({ agent: runtime.id, store: runtime.store })),
  );
  const launcher: AgentDispatchLauncher = createCompositeLauncher(
    runtimes.map((runtime) => ({
      agent: runtime.id,
      launcher: runtime.launcher,
    })),
  );
  const defaultAgent = runtimes[0];
  // The cron database: the job schedule and the job-started-session
  // tags (the sidebar badges), one handle shared by the scheduler, the
  // routes, and the badge reads.
  const cronDb = openCronDb(opts.cronDbPath);
  backfillCronAgents(cronDb, defaultAgent.id);
  // Scheduled runs from the cron database: an invalid job set fails
  // startup loudly; later database edits reload the schedule live.
  const cron = startCronScheduler({
    launcher,
    runner,
    agents: runtimes.map((runtime) => ({
      id: runtime.id,
      hasModels: runtime.models !== undefined,
    })),
    defaultAgent: defaultAgent.id,
    readJobs: () => listCronJobs(cronDb, defaultAgent.id),
    watchJobs: watchCronJobs,
    tagSession: (sessionId, jobName) =>
      tagCronSession(cronDb, sessionId, jobName),
    // One-shots retire themselves from the database once their moment
    // passes, so the store (and the UI reading it) tell the truth.
    retireOneShot: (jobName) => deleteCronJob(cronDb, jobName),
    // Every fire records the occurrence it serves — the missed-run
    // marker catch-up compares against on the next start.
    recordFire: (jobName, occurrence) =>
      recordCronFire(cronDb, jobName, occurrence),
  });
  // The suggested-next-prompts store and watcher. The setting is read
  // fresh each poll, so toggling the feature applies without a restart.
  const suggestionsDb = openSuggestionsDb(opts.suggestionsDbPath);
  const suggestionsScratch = resolveDataPath(
    undefined,
    "GLV_SUGGESTIONS_DIR",
    opts.dataDirName,
    "suggestions",
  );
  mkdirSync(suggestionsScratch, { recursive: true });
  const suggestionService = createSuggestionService({
    db: suggestionsDb,
    runner,
    sessions,
    cronDb,
    scratchDir: suggestionsScratch,
    askOf: (agentId) =>
      opts.agents
        .find((spec) => spec.profile.id === agentId)
        ?.ephemeralAsk(suggestionsScratch),
    modelFor: makeSuggestionModelResolver(runtimes, suggestionsDb),
  });

  const authDb = openAuthDb(opts.authDbPath);
  const promptsDb = openPromptsDb(opts.promptsDbPath);
  const groupsDb = openGroupsDb(opts.groupsDbPath);
  const auth = makeAuthService(authDb, opts.authDbPath);
  const app = createApp(sessions, launcher, runner, {
    agents: runtimes,
    assetsFlavor: opts.assetsFlavor,
    dataDirName: opts.dataDirName,
    auth,
    prompts: promptsDb,
    groups: groupsDb,
    cronDb,
    suggestions: suggestionsDb,
    stopNotices,
    onCronJobsChange: cron.reload,
    runCronJob: cron.runNow,
    rpName: opts.rpName,
    rpIdOverride: opts.rpIdOverride,
  });
  // One banner for one product: the served agents ride along in
  // parentheses (the same spelling as ctx.agentNames) instead of
  // reviving the retired glv-goose/glv-claude product names on
  // single-agent machines.
  const agentNames = runtimes
    .map((runtime) => runtime.profile.agentName)
    .join(" + ");
  app.listen({ port: opts.port, host: "::" }, (err, address) => {
    if (err !== null) {
      console.error(err);
      process.exit(1);
    }
    console.log(
      `glv web viewer (${agentNames}) → ${address.replace("[::]", "localhost")}`,
    );
    // Enumerating a model catalogue can spawn the agent binary, which
    // takes seconds; warm every picker now so the first New Session
    // render is instant. Best-effort only: a failure degrades the
    // picker, never the server.
    for (const runtime of runtimes) void runtime.models?.choices();
  });
  const destroyConnections = trackConnections(app.server);

  const closeDbs = (): void => {
    for (const spec of opts.agents) spec.closeStore();
    authDb.close();
    promptsDb.close();
    groupsDb.close();
    cronDb.close();
    suggestionsDb.close();
    stopNotices.close();
  };

  // Last-resort synchronous reap: fires on any JS-executing exit but not
  // SIGKILL, so detached agent children are reaped even if the async
  // shutdown above never started or finished.
  process.on("exit", () => {
    stopAll(runner);
  });

  const shutdown = createShutdown({
    server: app,
    destroyConnections,
    stopCron: cron.stop,
    stopSuggestions: suggestionService.stop,
    stopProcesses: () => stopAll(runner),
    closeDbs,
    exit: (code?: number) => process.exit(code),
  });
  registerShutdown(shutdown);
};

export type { AgentServeSpec };
export { runServe };
