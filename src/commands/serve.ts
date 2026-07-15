import type { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { buildScripts, buildStyles } from "../build.js";
import type { RunnerConfig } from "../runner.js";
import { createRunner, stopAll } from "../runner.js";
import { createApp } from "../server.js";

type ServeOpts = {
  port: number;
  runner: RunnerConfig;
};

const runServe = (db: DatabaseSync, opts: ServeOpts): void => {
  buildStyles();
  buildScripts();
  // Created here (not inside createApp) so SIGINT/SIGTERM can reap the
  // detached goose processes that would otherwise outlive the viewer.
  const runner = createRunner(opts.runner);
  const app = createApp(db, runner);
  const server = serve({ fetch: app.fetch, port: opts.port }, (info) =>
    console.log(`glv web viewer → http://localhost:${info.port}`),
  );

  const shutdown = (): void => {
    stopAll(runner);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

export { runServe };
