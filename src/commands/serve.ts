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

// http.Server.close only stops *accepting* connections; in-flight requests
// drain asynchronously. Narrowing to the close capability keeps shutdown
// testable without spinning up a real server.
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

// Drain in-flight requests, stop every goose process, then close the SQLite
// handles. A guard makes overlapping signals idempotent: a second interrupt
// while draining force-quits so a wedged request can't hang the viewer, and
// cleanup never runs twice.
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

// Minimal surface so tests can inject a fake emitter instead of `process`.
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
  // Without these, a thrown error or a rejected promise reaps neither the
  // detached goose processes nor the SQLite handles. SIGKILL (-9) runs no
  // user code, so a truly forced kill may still orphan children.
  emitter.on("uncaughtException", onCrash);
  emitter.on("unhandledRejection", onCrash);
};

const runServe = (db: DatabaseSync, opts: ServeOpts): void => {
  buildStyles();
  buildScripts();
  // Created here (not inside createApp) so shutdown can reap the
  // detached goose processes that would otherwise outlive the viewer.
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

  // Last-resort synchronous reap. Fires on every JS-executing exit
  // (process.exit, an uncaught exception, a natural drain) but not on
  // SIGKILL. process.kill on a process group is a synchronous syscall, so
  // this reaps detached goose children even when the async shutdown above
  // never started or never finished.
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
