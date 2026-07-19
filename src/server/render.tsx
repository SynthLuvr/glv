import { type Context } from "hono";
import { type Child, Fragment, type PropsWithChildren } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SessionRow } from "../db.js";
import { listSessions } from "../db.js";
import { listCategories, listPrompts } from "../prompts/db.js";
import { Layout } from "../views/Layout.js";
import {
  NewSessionForm,
  NotFoundDetail,
  type SourceType,
} from "../views/new-session.js";
import { SessionList, Sidebar } from "../views/Sidebar.js";
import type { AppEnv, ServerContext } from "./context.js";
import { VIEWER_FILTER } from "./context.js";
import { activeSessionIds } from "./status.js";
import { isHtmxRequest } from "./util.js";

const Shell = ({
  sessions,
  selectedId,
  runningIds,
  logout = false,
  children,
}: PropsWithChildren<{
  sessions: SessionRow[];
  selectedId: string | undefined;
  runningIds: Set<string>;
  logout?: boolean;
}>) => (
  <Layout title="Goose Sessions">
    <div class="app">
      <Sidebar
        sessions={sessions}
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
  c: Context<AppEnv>,
  ctx: ServerContext,
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
) => {
  const runningIds = activeSessionIds(ctx.runner);
  const showLogout = ctx.auth !== undefined;
  return isHtmxRequest(c)
    ? c.html(
        <Fragment>
          {detail}
          {refreshSidebar && (
            <SessionList
              sessions={sessions}
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
          selectedId={selectedId}
          runningIds={runningIds}
          logout={showLogout}
        >
          {detail}
        </Shell>,
        status,
      );
};

const renderNotFound = (c: Context<AppEnv>, ctx: ServerContext, id: string) =>
  render(
    c,
    ctx,
    listSessions(ctx.db, VIEWER_FILTER),
    undefined,
    <NotFoundDetail id={id} />,
    { status: 404 },
  );

const newSessionDetail = (
  ctx: ServerContext,
  error?: string,
  source: SourceType = "working_dir",
  repo?: string,
  branch?: string,
  // Optional working directory to pre-fill (e.g. from the worktree chip link);
  // falls back to the server's cwd when unset.
  workingDir?: string,
): Child => {
  const db = ctx.prompts;
  const prompts = db !== undefined ? listPrompts(db) : [];
  const categories = db !== undefined ? listCategories(db) : [];
  return (
    <NewSessionForm
      workingDir={workingDir ?? process.cwd()}
      dirs={ctx.listDirs()}
      error={error}
      source={source}
      repo={repo}
      branch={branch}
      prompts={prompts}
      categories={categories}
    />
  );
};

export { newSessionDetail, render, renderNotFound };
