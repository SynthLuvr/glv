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

// close() stops accepting connections; in-flight requests drain asynchronously.
type CloseableServer = {
  close: (callback?: (err?: Error) => void) => void;
};

const closeServer = (server: CloseableServer): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

type ShutdownDeps = {
  server: CloseableServer;
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
    stopProcesses: () => stopAll(runner),
    closeDbs,
    exit: (code?: number) => process.exit(code),
  });
  registerShutdown(shutdown);
};

export { closeServer, createShutdown, registerShutdown, runServe };
