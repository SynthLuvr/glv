import type { Socket } from "node:net";
import { openAuthDb } from "../auth/db.js";
import { makeAuthService } from "../auth/service.js";
import { buildAssets } from "../build.js";
import {
  type AgentDispatchLauncher,
  createCompositeLauncher,
  singleAgentDispatch,
} from "../composite-launcher.js";
import { createCompositeSessionStore } from "../composite-store.js";
import { startCronScheduler } from "../cron.js";
import {
  deleteCronJob,
  listCronJobs,
  openCronDb,
  recordCronFire,
  watchCronJobs,
} from "../cron-jobs.js";
import { tagCronSession } from "../cron-sessions.js";
import { openGroupsDb } from "../groups/db.js";
import type { SessionLauncher } from "../launch.js";
import { setupLogging } from "../log.js";
import type { FlavorProfile } from "../profile.js";
import { openPromptsDb } from "../prompts/db.js";
import {
  createRunner,
  type Runner,
  type RunnerConfig,
  stopAll,
} from "../runner/index.js";
import type { AgentRuntime } from "../server/context.js";
import { createApp } from "../server/index.js";
import type { SessionStore } from "../sessions.js";

// One agent's wiring as a serve caller provides it: the flavor adapters
// (store, launcher factory, argv builder, optional model picker) plus
// how to close the store on shutdown. `prefix` is the id namespace the
// launcher composes ids under — the flavor's id on the merged server,
// "" (native ids) on a single-flavor one.
type AgentServeSpec = {
  readonly profile: FlavorProfile;
  readonly store: SessionStore;
  readonly invocation: AgentRuntime["invocation"];
  readonly models: AgentRuntime["models"];
  readonly makeLauncher: (runner: Runner) => SessionLauncher;
  readonly closeStore: () => void;
};

type ServeOpts = {
  port: number;
  /** One runner config: one concurrency pool across every agent. */
  runner: RunnerConfig;
  /** The agents to serve, in picker order; never empty. */
  agents: readonly {
    readonly agent: string;
    readonly spec: AgentServeSpec;
  }[];
  /**
   * True composes the agents (namespaced ids, agent picker); false
   * serves the single agent exactly as the per-flavor servers always
   * have (native ids, no picker).
   */
  composed: boolean;
  /** Viewer-owned data directory name (uploads/temp root). */
  dataDirName: string;
  /** The dist/<name> directory the asset bundle reads. */
  assetsFlavor: string;
  authDbPath: string;
  promptsDbPath: string;
  groupsDbPath: string;
  cronDbPath: string;
  rpName: string;
  rpIdOverride?: string;
  debug: boolean;
};

// close() stops accepting connections; in-flight requests drain asynchronously.
type CloseableServer = {
  close: (callback?: (err?: Error) => void) => void;
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

// Binds the store and launcher the routes see: several agents compose
// (every id crossing the boundary namespaced by its agent), one agent
// passes through untouched — a composite of one is the identity.
const assembleAgents = (
  runtimes: readonly AgentRuntime[],
  composed: boolean,
): {
  readonly sessions: SessionStore;
  readonly launcher: AgentDispatchLauncher;
} => {
  if (runtimes.length === 1 && !composed)
    return {
      sessions: runtimes[0].store,
      launcher: singleAgentDispatch(runtimes[0].launcher),
    };
  return {
    sessions: createCompositeSessionStore(
      runtimes.map((runtime) => ({ agent: runtime.id, store: runtime.store })),
    ),
    launcher: createCompositeLauncher(
      runtimes.map((runtime) => ({
        agent: runtime.id,
        launcher: runtime.launcher,
      })),
    ),
  };
};

const runServe = (opts: ServeOpts): void => {
  setupLogging(opts.debug);
  buildAssets(opts.assetsFlavor);
  // Created here so shutdown can reap detached agent processes. One
  // runner, one concurrency pool, every agent.
  const runner = createRunner(opts.runner);
  const runtimes: AgentRuntime[] = opts.agents.map(({ agent, spec }) => ({
    id: agent,
    profile: spec.profile,
    store: spec.store,
    launcher: spec.makeLauncher(runner),
    invocation: spec.invocation,
    models: spec.models,
  }));
  const { sessions, launcher } = assembleAgents(runtimes, opts.composed);
  const defaultAgent = runtimes[0];
  // The cron database: the job schedule and the job-started-session
  // tags (the sidebar badges), one handle shared by the scheduler, the
  // routes, and the badge reads.
  const cronDb = openCronDb(opts.cronDbPath, defaultAgent.id);
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
    onCronJobsChange: cron.reload,
    rpName: opts.rpName,
    rpIdOverride: opts.rpIdOverride,
  });
  const product =
    opts.composed && runtimes.length > 1
      ? "glv"
      : `glv-${runtimes.map((runtime) => runtime.id).join("-")}`;
  app.listen({ port: opts.port, host: "::" }, (err, address) => {
    if (err !== null) {
      console.error(err);
      process.exit(1);
    }
    console.log(
      `${product} web viewer → ${address.replace("[::]", "localhost")}`,
    );
    // Enumerating a model catalogue can spawn the agent binary, which
    // takes seconds; warm every picker now so the first New Session
    // render is instant. Best-effort only: a failure degrades the
    // picker, never the server.
    for (const runtime of runtimes) void runtime.models?.choices();
  });
  const destroyConnections = trackConnections(app.server);

  const closeDbs = (): void => {
    for (const { spec } of opts.agents) spec.closeStore();
    authDb.close();
    promptsDb.close();
    groupsDb.close();
    cronDb.close();
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
    stopProcesses: () => stopAll(runner),
    closeDbs,
    exit: (code?: number) => process.exit(code),
  });
  registerShutdown(shutdown);
};

export type { AgentServeSpec };
export { runServe };
