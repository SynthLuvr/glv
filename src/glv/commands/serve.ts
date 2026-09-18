import type { Socket } from "node:net";
import { openAuthDb } from "../auth/db.js";
import { makeAuthService } from "../auth/service.js";
import { buildAssets } from "../build.js";
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
import type { ModelSource } from "../models.js";
import type { FlavorProfile } from "../profile.js";
import { openPromptsDb } from "../prompts/db.js";
import {
  createRunner,
  type Runner,
  type RunnerConfig,
  stopAll,
} from "../runner/index.js";
import { createApp } from "../server/index.js";
import type { SessionStore } from "../sessions.js";

type ServeOpts = {
  port: number;
  profile: FlavorProfile;
  runner: RunnerConfig;
  /** Binds the flavor's new-session strategy once the runner exists. */
  makeLauncher: (runner: Runner) => SessionLauncher;
  /** Optional model picker source; undefined hides the picker entirely. */
  models?: ModelSource;
  /** Closes the flavor's storage handles on shutdown. */
  closeStore: () => void;
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

const runServe = (sessions: SessionStore, opts: ServeOpts): void => {
  setupLogging(opts.debug);
  buildAssets(opts.profile.id);
  // Created here so shutdown can reap detached agent processes.
  const runner = createRunner(opts.runner);
  const launcher = opts.makeLauncher(runner);
  // The cron database: the job schedule and the job-started-session
  // tags (the sidebar badges), one handle shared by the scheduler, the
  // routes, and the badge reads.
  const cronDb = openCronDb(opts.cronDbPath);
  // Scheduled runs from the cron database: an invalid job set fails
  // startup loudly; later database edits reload the schedule live.
  const cron = startCronScheduler({
    launcher,
    runner,
    readJobs: () => listCronJobs(cronDb),
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
    // Without a ModelSource the flavor cannot honor a model pin.
    supportsModels: opts.models !== undefined,
  });
  const authDb = openAuthDb(opts.authDbPath);
  const promptsDb = openPromptsDb(opts.promptsDbPath);
  const groupsDb = openGroupsDb(opts.groupsDbPath);
  const auth = makeAuthService(authDb, opts.authDbPath);
  const app = createApp(sessions, launcher, runner, {
    profile: opts.profile,
    auth,
    prompts: promptsDb,
    groups: groupsDb,
    models: opts.models,
    cronDb,
    onCronJobsChange: cron.reload,
    rpName: opts.rpName,
    rpIdOverride: opts.rpIdOverride,
  });
  app.listen({ port: opts.port, host: "::" }, (err, address) => {
    if (err !== null) {
      console.error(err);
      process.exit(1);
    }
    console.log(
      `glv-${opts.profile.id} web viewer → ${address.replace("[::]", "localhost")}`,
    );
    // Enumerating the model catalogue can spawn the agent binary, which
    // takes seconds; warm it now so the first New Session render is instant.
    // Best-effort only: a failure degrades the picker, never the server.
    void opts.models?.choices();
  });
  const destroyConnections = trackConnections(app.server);

  const closeDbs = (): void => {
    opts.closeStore();
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

export { runServe };
