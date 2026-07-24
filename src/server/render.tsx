import { type Context } from "hono";
import { type Child, Fragment, type PropsWithChildren } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SessionRow } from "../db.js";
import { listSessions } from "../db.js";
import { listGroups } from "../groups/db.js";
import type { ListEntry } from "../groups/model.js";
import { buildEntries } from "../groups/model.js";
import { listCategories, listPrompts } from "../prompts/db.js";
import { Layout } from "../views/Layout.js";
import { NewSessionForm, NotFoundDetail } from "../views/new-session.js";
import { SessionList, Sidebar } from "../views/Sidebar.js";
import type { ServerContext } from "./context.js";
import { VIEWER_FILTER } from "./context.js";
import { isHtmxRequest } from "./http.js";
import { activeSessionIds } from "./status.js";

// Folds the goose session list and the viewer-owned group memberships into a
// single ordered entry list.  When the groups sidecar is absent the list is
// purely flat — identical to today's experience.
const sidebarEntries = (
  ctx: ServerContext,
  sessions: SessionRow[],
): ListEntry[] => {
  if (ctx.groups === undefined)
    return sessions.map((session) => ({ kind: "session", session }));
  return buildEntries(sessions, listGroups(ctx.groups));
};

const PaneButton = ({
  pane,
  title,
  label,
  children,
}: PropsWithChildren<{ pane: string; title: string; label: string }>) => (
  <button
    type="button"
    class="mobile-pane-btn"
    data-pane={pane}
    aria-pressed="false"
    title={title}
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
    <span>{label}</span>
  </button>
);

const MobilePaneToggle = () => (
  <nav class="mobile-pane-toggle" aria-label="Switch view">
    <PaneButton pane="sidebar" title="Show sessions" label="Sessions">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </PaneButton>
    <PaneButton pane="detail" title="Show detail" label="Detail">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </PaneButton>
  </nav>
);

const Shell = ({
  sessions,
  entries,
  selectedId,
  runningIds,
  logout = false,
  children,
  title,
}: PropsWithChildren<{
  sessions: SessionRow[];
  entries: ListEntry[];
  selectedId: string | undefined;
  runningIds: Set<string>;
  logout?: boolean;
  title: string;
}>) => (
  <Layout title={title}>
    <div
      class="app"
      data-mobile-pane={selectedId !== undefined ? "detail" : "sidebar"}
    >
      <MobilePaneToggle />
      <Sidebar
        sessions={sessions}
        entries={entries}
        selectedId={selectedId}
        runningIds={runningIds}
        logout={logout}
      />
      <main class="detail" id="detail-pane">
        {children}
      </main>
    </div>
  </Layout>
);

// htmx navigation swaps only the detail pane so an in-progress bulk
// selection survives. Mutations additionally refresh the sidebar
// out-of-band.
const render = (
  c: Context,
  ctx: ServerContext,
  sessions: SessionRow[],
  selectedId: string | undefined,
  detail: Child,
  {
    refreshSidebar = false,
    status = 200,
    title = "Guided Live Velocity",
  }: {
    refreshSidebar?: boolean;
    status?: ContentfulStatusCode;
    title?: string;
  } = {},
) => {
  const entries = sidebarEntries(ctx, sessions);
  const runningIds = activeSessionIds(ctx.runner);
  const showLogout = ctx.auth !== undefined;
  return isHtmxRequest(c)
    ? c.html(
        <Fragment>
          {detail}
          {refreshSidebar && (
            <SessionList
              entries={entries}
              selectedId={undefined}
              runningIds={runningIds}
              oob
            />
          )}
        </Fragment>,
        status,
      )
    : c.html(
        <Shell
          sessions={sessions}
          entries={entries}
          selectedId={selectedId}
          runningIds={runningIds}
          logout={showLogout}
          title={title}
        >
          {detail}
        </Shell>,
        status,
      );
};

const renderNotFound = (c: Context, ctx: ServerContext, id: string) =>
  render(
    c,
    ctx,
    listSessions(ctx.db, VIEWER_FILTER),
    undefined,
    <NotFoundDetail id={id} />,
    { status: 404, title: "Session not found — Guided Live Velocity" },
  );

const newSessionDetail = (
  ctx: ServerContext,
  { error, workingDir }: { error?: string; workingDir?: string } = {},
): Child => {
  const db = ctx.prompts;
  const prompts = db !== undefined ? listPrompts(db) : [];
  const categories = db !== undefined ? listCategories(db) : [];
  return (
    <NewSessionForm
      workingDir={workingDir ?? process.cwd()}
      dirs={ctx.listDirs()}
      error={error}
      prompts={prompts}
      categories={categories}
    />
  );
};

export { newSessionDetail, render, renderNotFound, sidebarEntries };
