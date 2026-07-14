import type { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { createApp } from "../server.js";

type ServeOpts = {
  port: number;
};

const runServe = (db: DatabaseSync, opts: ServeOpts): void => {
  const app = createApp(db);
  serve({ fetch: app.fetch, port: opts.port }, (info) =>
    console.log(`glv web viewer → http://localhost:${info.port}`),
  );
};

export type { ServeOpts };
export { runServe };
