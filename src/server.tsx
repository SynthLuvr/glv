import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { type Child, Fragment, type PropsWithChildren } from "hono/jsx";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import type { SessionFilter, SessionRow } from "./db.js";
import {
  archiveSessions,
  getSession,
  listMessages,
  listSessions,
} from "./db.js";
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

// Resolved via import.meta so the asset is found regardless of launch directory.
const htmxSource = readFileSync(
  fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js")),
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

const extractIds = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
};

// htmx navigation swaps only the detail pane so an in-progress bulk selection
// survives. Mutations additionally refresh the sidebar out-of-band.
const render = (
  c: Context,
  sessions: SessionRow[],
  selectedId: string | undefined,
  detail: Child,
  {
    refreshSidebar = false,
    status = 200,
  }: {
    refreshSidebar?: boolean;
    status?: ContentfulStatusCode;
  } = {},
) =>
  isHtmxRequest(c)
    ? c.html(
        <Fragment>
          {detail}
          {refreshSidebar && (
            <SessionList sessions={sessions} selectedId={undefined} oob />
          )}
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
    return render(c, sessions, undefined, <DetailPlaceholder />);
  });

  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const sessions = listSessions(db, VIEWER_FILTER);
    const session = getSession(db, id);
    if (session === undefined)
      return render(c, sessions, undefined, <NotFoundDetail id={id} />, {
        status: 404,
      });
    const messages = listMessages(db, id).map(parseMessage);
    return render(
      c,
      sessions,
      id,
      <Transcript session={session} messages={messages} />,
    );
  });

  app.post("/sessions/:id/archive", (c) => {
    const id = c.req.param("id");
    archiveSessions(db, [id]);
    const sessions = listSessions(db, VIEWER_FILTER);
    return render(c, sessions, undefined, <DetailPlaceholder />, {
      refreshSidebar: true,
    });
  });

  app.post("/sessions/archive", async (c) => {
    const body = (await c.req.parseBody({ all: true })) as Record<
      string,
      unknown
    >;
    archiveSessions(db, extractIds(body.id));
    const sessions = listSessions(db, VIEWER_FILTER);
    return c.html(<SessionList sessions={sessions} selectedId={undefined} />);
  });

  return app;
};

export { createApp };
