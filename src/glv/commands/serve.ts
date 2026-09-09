import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { openAuthDb } from "../auth/db.js";
import { makeAuthService } from "../auth/service.js";
import { buildAssets } from "../build.js";
import {
  importLegacyConfigValues,
  openConfigDb,
  readLegacyConfigFile,
  resolveForwardHost,
} from "../config.js";
import { startCronScheduler, validateCronJobSet } from "../cron.js";
import {
  deleteCronJob,
  importCronJobsFromLegacyConfig,
  listCronJobs,
  openCronDb,
  watchCronJobs,
} from "../cron-jobs.js";
import { tagCronSession } from "../cron-sessions.js";
import { startForwardTunnel, type TunnelHandle } from "../forward.js";
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
  configDbPath: string;
  rpName: string;
  rpIdOverride?: string;
  /** Opens the reverse tunnel when set (--forward). */
  forward: boolean;
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
  stopTunnel: () => void;
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
    deps.stopTunnel();
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
  // The config database: boot-time scalars (forwardHost) and the
  // landing zone for the retired config file's keys.
  const configDb = openConfigDb(opts.configDbPath);
  // A legacy file is imported once — its cronJobs array into the cron
  // database, every other key into the config database — then renamed
  // away (config.json.bak). An invalid file refuses startup before
  // anything is written, leaving it hand-fixable.
  const legacyConfig = readLegacyConfigFile(opts.profile.dataDirName);
  if (legacyConfig !== undefined) {
    importCronJobsFromLegacyConfig(cronDb, legacyConfig, (jobs) =>
      validateCronJobSet(jobs, opts.models !== undefined),
    );
    importLegacyConfigValues(configDb, legacyConfig, opts.profile.dataDirName);
  }
  // Resolved after the import above, so a first boot whose host still
  // lives in a file finds it; every later boot reads the database only.
  const forwardHost = opts.forward
    ? resolveForwardHost(configDb, opts.profile.id)
    : undefined;
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
  // Started once the port is bound so the -R bind targets the real listener.
  let tunnel: TunnelHandle | undefined;
  const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
    console.log(
      `glv-${opts.profile.id} web viewer → http://localhost:${info.port}`,
    );
    // Enumerating the model catalogue can spawn the agent binary, which
    // takes seconds; warm it now so the first New Session render is instant.
    // Best-effort only: a failure degrades the picker, never the server.
    void opts.models?.choices();
    if (forwardHost !== undefined)
      tunnel = startForwardTunnel(info.port, forwardHost);
  });
  const destroyConnections = trackConnections(server);

  const closeDbs = (): void => {
    opts.closeStore();
    authDb.close();
    promptsDb.close();
    groupsDb.close();
    cronDb.close();
    configDb.close();
  };

  // Last-resort synchronous reap: fires on any JS-executing exit but not
  // SIGKILL, so detached agent children (and the ssh tunnel) are reaped even
  // if the async shutdown above never started or finished.
  process.on("exit", () => {
    stopAll(runner);
    tunnel?.kill();
  });

  const shutdown = createShutdown({
    server,
    destroyConnections,
    stopCron: cron.stop,
    stopProcesses: () => stopAll(runner),
    stopTunnel: () => tunnel?.kill(),
    closeDbs,
    exit: (code?: number) => process.exit(code),
  });
  registerShutdown(shutdown);
};

export { runServe };
