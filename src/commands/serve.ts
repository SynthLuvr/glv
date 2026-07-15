import type { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import type { RunnerConfig } from "../runner.js";
import { createRunner, stopAll } from "../runner.js";
import { createApp } from "../server.js";

type ServeOpts = {
  port: number;
  runner: RunnerConfig;
};

const runServe = (db: DatabaseSync, opts: ServeOpts): void => {
  // Create the runner here (rather than inside createApp) so we can reap
  // every active goose process group when the viewer shuts down. goose runs
  // spawn detached so Stop can kill the whole tree, but that also means they
  // survive the viewer — without this cleanup they would leak as orphans.
  const runner = createRunner(opts.runner);
  const app = createApp(db, opts.runner, undefined, runner);
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
