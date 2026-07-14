import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { type Child, Fragment, type PropsWithChildren } from "hono/jsx";
import { type ContentfulStatusCode } from "hono/utils/http-status";
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
const htmxSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public", "htmx.min.js"),
  "utf8",
);

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

const isHtmxRequest = (c: Context): boolean =>
  c.req.header("HX-Request") === "true";

// htmx clicks get just the detail pane plus an out-of-band sidebar update;
// everything else gets the full document.
const respond = (
  c: Context,
  sessions: SessionRow[],
  selectedId: string | undefined,
  detail: Child,
  status: ContentfulStatusCode = 200,
) =>
  isHtmxRequest(c)
    ? c.html(
        <Fragment>
          {detail}
          <SessionList sessions={sessions} selectedId={selectedId} oob />
        </Fragment>,
        status,
      )
    : c.html(
        <Shell sessions={sessions} selectedId={selectedId}>
          {detail}
        </Shell>,
        status,
      );

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
    return respond(c, sessions, undefined, <DetailPlaceholder />);
  });

  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const sessions = listSessions(db, VIEWER_FILTER);
    const session = getSession(db, id);
    if (session === undefined)
      return respond(c, sessions, undefined, <NotFoundDetail id={id} />, 404);
    const messages = listMessages(db, id).map(parseMessage);
    return respond(
      c,
      sessions,
      id,
      <Transcript session={session} messages={messages} />,
    );
  });

  return app;
};

export { createApp };
