import { type Context } from "hono";
import { type Child, Fragment, type PropsWithChildren } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { NamedCronJob } from "../config.js";
import { readCronJobs } from "../config.js";
import { listGroups } from "../groups/db.js";
import type { ListEntry } from "../groups/model.js";
import { buildEntries } from "../groups/model.js";
import { listCategories, listPrompts } from "../prompts/db.js";
import { withResolvedNames } from "../schedule.js";
import type { SessionRow } from "../sessions.js";
import { errorMessage } from "../util.js";
import { Layout } from "../views/Layout.js";
import {
  type ModelPicker,
  NewSessionForm,
  NotFoundDetail,
} from "../views/new-session.js";
import { SessionList, Sidebar } from "../views/Sidebar.js";
import type { ServerContext } from "./context.js";
import { VIEWER_FILTER } from "./context.js";
import { isHtmxRequest } from "./http.js";
import { activeSessionIds } from "./status.js";

// Folds the session list and the viewer-owned group memberships into a
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
  agentName,
}: PropsWithChildren<{
  sessions: SessionRow[];
  entries: ListEntry[];
  selectedId: string | undefined;
  runningIds: Set<string>;
  logout?: boolean;
  title: string;
  agentName: string;
}>) => (
  <Layout title={title} agentName={agentName}>
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
    title = "GLV",
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
          agentName={ctx.profile.agentName}
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
    ctx.sessions.listSessions(VIEWER_FILTER),
    undefined,
    <NotFoundDetail id={id} />,
    { status: 404, title: "Session not found — GLV" },
  );

// The picker shows only when the flavor exposes configured models and a
// resolvable default. Resolving the catalogue may spawn the agent binary
// (seconds), so this powers only the lazy /sessions/model-picker fragment —
// never the New Session form, which must render instantly. `submitted`
// carries a rejected submit's value so the selection survives.
const modelPicker = async (
  ctx: ServerContext,
  submitted: string | undefined,
): Promise<ModelPicker | undefined> => {
  const source = ctx.models;
  if (source === undefined) return undefined;
  const defaultSelection = source.defaultSelection();
  if (defaultSelection === undefined) return undefined;
  const choices = await source.choices();
  if (choices.length === 0) return undefined;
  const value = submitted ?? "";
  return {
    choices,
    defaultLabel: `${defaultSelection.provider} / ${defaultSelection.model}`,
    selected: choices.some((choice) => choice.value === value) ? value : "",
  };
};

// Cheap sync gate (config read, never a spawn) deciding whether the form
// renders the lazy slot at all: flavors without model support (claude) and
// provider-less configs get no field.
const hasModelPicker = (ctx: ServerContext): boolean =>
  ctx.models?.defaultSelection() !== undefined;

// Everything a rejected submit needs to re-render the form without losing
// typed work, plus the confirmation shown after a job is saved.
type NewSessionDetailOpts = {
  error?: string;
  workingDir?: string;
  prompt?: string;
  modelProvider?: string;
  schedule?: string;
  scheduleName?: string;
  confirmation?: NamedCronJob;
};

// Reads the config file's cron jobs for the Scheduled runs section. A
// config broken by a hand edit must not take the page down.
const safeCronJobs = (ctx: ServerContext): NamedCronJob[] => {
  try {
    return withResolvedNames(readCronJobs(ctx.profile.dataDirName));
  } catch (err) {
    console.error(`cron: could not read jobs for the UI: ${errorMessage(err)}`);
    return [];
  }
};

const newSessionDetail = (
  ctx: ServerContext,
  {
    error,
    workingDir,
    prompt = "",
    modelProvider,
    schedule = "",
    scheduleName = "",
    confirmation,
  }: NewSessionDetailOpts = {},
): Child => {
  const db = ctx.prompts;
  const prompts = db !== undefined ? listPrompts(db) : [];
  const categories = db !== undefined ? listCategories(db) : [];
  return (
    <NewSessionForm
      agentName={ctx.profile.agentName}
      workingDir={workingDir ?? process.cwd()}
      dirs={ctx.listDirs()}
      error={error}
      prompt={prompt}
      prompts={prompts}
      categories={categories}
      modelPicker={
        hasModelPicker(ctx) ? { submitted: modelProvider } : undefined
      }
      schedule={schedule}
      scheduleName={scheduleName}
      jobs={safeCronJobs(ctx)}
      confirmation={confirmation}
    />
  );
};

export {
  modelPicker,
  newSessionDetail,
  render,
  renderNotFound,
  sidebarEntries,
};
