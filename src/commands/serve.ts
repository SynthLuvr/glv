import type { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { buildStyles } from "../build.js";
import type { RunnerConfig } from "../runner.js";
import { createApp } from "../server.js";

type ServeOpts = {
  port: number;
  runner: RunnerConfig;
};

const runServe = (db: DatabaseSync, opts: ServeOpts): void => {
  buildStyles();
  const app = createApp(db, opts.runner);
  serve({ fetch: app.fetch, port: opts.port }, (info) =>
    console.log(`glv web viewer → http://localhost:${info.port}`),
  );
};

export { runServe };
