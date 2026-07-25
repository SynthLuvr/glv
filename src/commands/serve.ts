import { type FSWatcher, watch } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { openAuthDb } from "../auth/db.js";
import { makeAuthService } from "../auth/service.js";
import { buildScripts, buildStyles } from "../build.js";
import { startForwardTunnel, type TunnelHandle } from "../forward.js";
import { openGroupsDb } from "../groups/db.js";
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
  hot?: boolean;
};

const HOT_RELOAD_DEBOUNCE_MS = 300;

// Watches frontend source directories (scripts, styles, views) and triggers
// a debounced rebuild + asset reload. Returns a cleanup function that aborts
// every watcher so shutdown can stop them deterministically.
const startHotReloadWatcher = (reload: () => void): (() => void) => {
  const srcDir = fileURLToPath(new URL("../", import.meta.url));
  const watchDirs = [
    join(srcDir, "scripts"),
    join(srcDir, "styles"),
    join(srcDir, "views"),
  ];

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];

  const onFileChange = (): void => {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      try {
        buildScripts();
        buildStyles();
        reload();
        console.log("glv hot reload → assets rebuilt");
      } catch (err) {
        console.error("glv hot reload → build failed:", err);
      }
    }, HOT_RELOAD_DEBOUNCE_MS);
  };

  for (const dir of watchDirs)
    try {
      watchers.push(watch(dir, { recursive: true }, onFileChange));
    } catch {
      // Directory may not exist in stripped installs; skip silently.
    }

  return () => {
    for (const w of watchers) w.close();
    if (debounce !== undefined) clearTimeout(debounce);
  };
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
  stopWatcher: () => void;
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
    deps.stopWatcher();
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
  const promptsDb = openPromptsDb(opts.promptsDbPath);
  const groupsDb = openGroupsDb(opts.groupsDbPath);
  const auth = makeAuthService(authDb);
  const { app, reload } = createApp(db, runner, {
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

  const stopWatcher =
    opts.hot === true
      ? startHotReloadWatcher(reload)
      : (): void => {
          /* hot reload disabled */
        };

  const closeDbs = (): void => {
    db.close();
    authDb.close();
    promptsDb.close();
    groupsDb.close();
  };

  // Last-resort synchronous reap: fires on any JS-executing exit but not
  // SIGKILL, so detached goose children (and the ssh tunnel) are reaped even
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
    stopWatcher,
    closeDbs,
    exit: (code?: number) => process.exit(code),
  });
  registerShutdown(shutdown);
};

export { runServe };
