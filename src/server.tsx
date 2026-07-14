import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { PropsWithChildren } from "hono/jsx";
import type { SessionFilter, SessionRow } from "./db.js";
import { getSession, listMessages, listSessions } from "./db.js";
import { parseMessage } from "./format.js";
import { Layout } from "./views/Layout.js";
import { Sidebar } from "./views/Sidebar.js";
import {
  DetailPlaceholder,
  NotFoundDetail,
  Transcript,
} from "./views/Transcript.js";

const VIEWER_FILTER: SessionFilter = {
  type: "user",
  limit: 100,
  includeArchived: false,
};

const Shell = ({
  sessions,
  selectedId,
  children,
}: PropsWithChildren<{
  sessions: SessionRow[];
  selectedId: string | undefined;
}>) => (
  <Layout title="Goose Sessions">
    <div class="app">
      <Sidebar sessions={sessions} selectedId={selectedId} />
      <main class="detail">{children}</main>
    </div>
  </Layout>
);

const createApp = (db: DatabaseSync): Hono => {
  const app = new Hono();
  app.get("/", (c) => {
    const sessions = listSessions(db, VIEWER_FILTER);
    return c.html(
      <Shell sessions={sessions} selectedId={undefined}>
        <DetailPlaceholder />
      </Shell>,
    );
  });
  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const sessions = listSessions(db, VIEWER_FILTER);
    const session = getSession(db, id);
    if (session === undefined)
      return c.html(
        <Shell sessions={sessions} selectedId={id}>
          <NotFoundDetail id={id} />
        </Shell>,
        404,
      );
    const messages = listMessages(db, id).map(parseMessage);
    return c.html(
      <Shell sessions={sessions} selectedId={id}>
        <Transcript session={session} messages={messages} />
      </Shell>,
    );
  });
  return app;
};

export { createApp };
