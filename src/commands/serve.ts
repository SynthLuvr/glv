import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { openAuthDb } from "../auth/db.js";
import { makeAuthService } from "../auth/service.js";
import { buildScripts, buildStyles } from "../build.js";
import type { SessionStore } from "../db.js";
import { startForwardTunnel, type TunnelHandle } from "../forward.js";
import { openGroupsDb } from "../groups/db.js";
import { setupLogging } from "../log.js";
import { openPromptsDb } from "../prompts/db.js";
import type { RunnerConfig } from "../runner/index.js";
import { createRunner, stopAll } from "../runner/index.js";
import { createApp } from "../server/index.js";

type ServeOpts = {
  port: number;
  runner: RunnerConfig;
  authDbPath: string;
  promptsDbPath: string;
  groupsDbPath: string;
  rpName: string;
  rpIdOverride?: string;
  forwardHost?: string;
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
  // Thrown errors/rejections would otherwise leak claude processes and DB handles.
  emitter.on("uncaughtException", onCrash);
  emitter.on("unhandledRejection", onCrash);
};

const runServe = (store: SessionStore, opts: ServeOpts): void => {
  setupLogging(opts.debug);
  buildStyles();
  buildScripts();
  // Created here so shutdown can reap detached claude processes.
  const runner = createRunner(opts.runner);
  const authDb = openAuthDb(opts.authDbPath);
  const promptsDb = openPromptsDb(opts.promptsDbPath);
  const groupsDb = openGroupsDb(opts.groupsDbPath);
  const auth = makeAuthService(authDb);
  const app = createApp(store, runner, {
    auth,
    prompts: promptsDb,
    groups: groupsDb,
    rpName: opts.rpName,
    rpIdOverride: opts.rpIdOverride,
  });
  // Started once the port is bound so the -R bind targets the real listener.
  let tunnel: TunnelHandle | undefined;
  const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
    console.log(`glv web viewer → http://localhost:${info.port}`);
    if (opts.forwardHost !== undefined)
      tunnel = startForwardTunnel(info.port, opts.forwardHost);
  });
  const destroyConnections = trackConnections(server);

  const closeDbs = (): void => {
    store.meta.close();
    authDb.close();
    promptsDb.close();
    groupsDb.close();
  };

  // Last-resort synchronous reap: fires on any JS-executing exit but not
  // SIGKILL, so detached claude children (and the ssh tunnel) are reaped even
  // if the async shutdown above never started or finished.
  process.on("exit", () => {
    stopAll(runner);
    tunnel?.kill();
  });

  const shutdown = createShutdown({
    server,
    destroyConnections,
    stopProcesses: () => stopAll(runner),
    stopTunnel: () => tunnel?.kill(),
    closeDbs,
    exit: (code?: number) => process.exit(code),
  });
  registerShutdown(shutdown);
};

export { runServe };
