import type { Socket } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { openAuthDb } from "../auth/db.js";
import { makeAuthService } from "../auth/service.js";
import { buildScripts, buildStyles } from "../build.js";
import type { RunnerConfig } from "../runner/index.js";
import { createRunner, stopAll } from "../runner/index.js";
import { createApp } from "../server/index.js";

type ServeOpts = {
  port: number;
  runner: RunnerConfig;
  authDbPath: string;
  rpName: string;
  rpIdOverride?: string;
};

// close() stops accepting new connections; in-flight requests drain
// asynchronously, so long-lived ones (SSE streams) must be torn down by hand.
type CloseableServer = {
  close: (callback?: (err?: Error) => void) => void;
};

// A server that surfaces every socket it opens so shutdown can destroy them.
type ConnectionTrackingServer = CloseableServer & {
  on: (event: "connection", listener: (socket: Socket) => void) => void;
};

const closeServer = (server: CloseableServer): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

// Tracks live sockets so a destroyer can force them down. Without this,
// server.close()'s callback waits for in-flight SSE requests — which never end
// on their own — and a single Ctrl+C hangs until the browser disconnects,
// forcing a second Ctrl+C to hit the force-exit escape hatch.
const trackConnections = (server: ConnectionTrackingServer): (() => void) => {
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
    // Tear down live sockets first so close()'s drain resolves promptly; the
    // SSE poll loops would otherwise keep the callback pending indefinitely.
    deps.destroyConnections();
    await closeServer(deps.server);
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
  // Thrown errors/rejections would otherwise leak goose processes and DB handles.
  emitter.on("uncaughtException", onCrash);
  emitter.on("unhandledRejection", onCrash);
};

const runServe = (db: DatabaseSync, opts: ServeOpts): void => {
  buildStyles();
  buildScripts();
  // Created here so shutdown can reap detached goose processes.
  const runner = createRunner(opts.runner);
  const authDb = openAuthDb(opts.authDbPath);
  const auth = makeAuthService(authDb);
  const app = createApp(db, runner, {
    auth,
    rpName: opts.rpName,
    rpIdOverride: opts.rpIdOverride,
  });
  const server = serve({ fetch: app.fetch, port: opts.port }, (info) =>
    console.log(`glv web viewer → http://localhost:${info.port}`),
  );
  const destroyConnections = trackConnections(server);

  const closeDbs = (): void => {
    db.close();
    authDb.close();
  };

  // Last-resort synchronous reap: fires on any JS-executing exit but not
  // SIGKILL, so detached goose children are reaped even if the async
  // shutdown above never started or finished.
  process.on("exit", () => stopAll(runner));

  const shutdown = createShutdown({
    server,
    destroyConnections,
    stopProcesses: () => stopAll(runner),
    closeDbs,
    exit: (code?: number) => process.exit(code),
  });
  registerShutdown(shutdown);
};

export {
  closeServer,
  createShutdown,
  registerShutdown,
  runServe,
  trackConnections,
};
