import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { SessionFilter } from "./db.js";
import { listSessions } from "./db.js";
import { Layout } from "./views/Layout.js";
import { SessionsPage } from "./views/sessions.js";

const VIEWER_FILTER: SessionFilter = {
  type: "user",
  limit: 100,
  includeArchived: false,
};

const createApp = (db: DatabaseSync): Hono => {
  const app = new Hono();
  app.get("/", (c) => {
    const sessions = listSessions(db, VIEWER_FILTER);
    return c.html(
      <Layout title="Goose Sessions">
        <SessionsPage sessions={sessions} />
      </Layout>,
    );
  });
  return app;
};

export { createApp };
