import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { Fragment, type PropsWithChildren } from "hono/jsx";
import type { SessionFilter, SessionRow } from "./db.js";
import { getSession, listMessages, listSessions } from "./db.js";
import { parseMessage } from "./format.js";
import { Layout } from "./views/Layout.js";
import { SessionList, Sidebar } from "./views/Sidebar.js";
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

// Resolved relative to this module so the asset is found regardless of the
// directory the server was launched from.
const HTMX_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "htmx.min.js",
);
const htmxSource = readFileSync(HTMX_PATH, "utf8");

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
      <main class="detail" id="detail-pane">
        {children}
      </main>
    </div>
  </Layout>
);

// htmx sets this header on every AJAX request, letting us answer with a
// partial (detail pane + out-of-band sidebar) instead of the full document.
const isHtmxRequest = (c: Context): boolean =>
  c.req.header("HX-Request") === "true";

const createApp = (db: DatabaseSync): Hono => {
  const app = new Hono();

  app.get("/htmx.min.js", (c) =>
    c.body(htmxSource, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    }),
  );

  app.get("/", (c) => {
    const sessions = listSessions(db, VIEWER_FILTER);
    if (isHtmxRequest(c))
      return c.html(
        <Fragment>
          <DetailPlaceholder />
          <SessionList sessions={sessions} selectedId={undefined} oob />
        </Fragment>,
      );
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
    if (session === undefined) {
      if (isHtmxRequest(c))
        return c.html(
          <Fragment>
            <NotFoundDetail id={id} />
            <SessionList sessions={sessions} selectedId={undefined} oob />
          </Fragment>,
          404,
        );
      return c.html(
        <Shell sessions={sessions} selectedId={id}>
          <NotFoundDetail id={id} />
        </Shell>,
        404,
      );
    }
    const messages = listMessages(db, id).map(parseMessage);
    if (isHtmxRequest(c))
      return c.html(
        <Fragment>
          <Transcript session={session} messages={messages} />
          <SessionList sessions={sessions} selectedId={id} oob />
        </Fragment>,
      );
    return c.html(
      <Shell sessions={sessions} selectedId={id}>
        <Transcript session={session} messages={messages} />
      </Shell>,
    );
  });

  return app;
};

export { createApp };
