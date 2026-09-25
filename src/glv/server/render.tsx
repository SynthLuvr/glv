import type { FastifyReply, FastifyRequest } from "fastify";
import { type Child, Fragment, type PropsWithChildren } from "hono/jsx";
import { type CronJobConfig, listCronJobs } from "../cron-jobs.js";
import { listGroups } from "../groups/db.js";
import type { ListEntry } from "../groups/model.js";
import { buildEntries } from "../groups/model.js";
import {
  type AgentModelPick,
  decodeAgentModelValue,
  encodeAgentModelValue,
  modelLabel,
} from "../models.js";
import { listCategories, listPrompts } from "../prompts/db.js";
import type { SessionRow } from "../sessions.js";
import { errorMessage } from "../util.js";
import { Layout } from "../views/Layout.js";
import {
  type AgentModelGroup,
  type ModelPicker,
  NewSessionForm,
  NotFoundDetail,
} from "../views/new-session.js";
import { SessionList, Sidebar } from "../views/Sidebar.js";
import type { AgentRuntime, ServerContext } from "./context.js";
import { VIEWER_FILTER } from "./context.js";
import { isHtmxRequest, sendHtml } from "./http.js";
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
  request: FastifyRequest,
  reply: FastifyReply,
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
    status?: number;
    title?: string;
  } = {},
): FastifyReply => {
  const entries = sidebarEntries(ctx, sessions);
  const runningIds = activeSessionIds(ctx.runner);
  const showLogout = ctx.auth !== undefined;
  if (isHtmxRequest(request))
    return sendHtml(
      reply,
      <Fragment>
        {detail}
        {refreshSidebar && (
          <SessionList
            entries={entries}
            selectedId={undefined}
            runningIds={runningIds}
            oob
            count={sessions.length}
          />
        )}
      </Fragment>,
      status,
    );
  return sendHtml(
    reply,
    <Shell
      agentName={ctx.agentNames}
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

const renderNotFound = (
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
  id: string,
): FastifyReply =>
  render(
    request,
    reply,
    ctx,
    ctx.sessions.listSessions(VIEWER_FILTER),
    undefined,
    <NotFoundDetail id={id} />,
    { status: 404, title: "Session not found — GLV" },
  );

// Splits a submitted combined model value ("<agent>:<model value>") into
// the agent it names and that agent's runtime. A value that decodes to
// no agent — absent, empty, or malformed — falls back to `fallbackAgent`
// (the server default, or the stored row's own agent). `runtime` is
// undefined when the named agent is not served; `modelValue` is the
// remainder for the agent's own model source to resolve.
const resolveAgentPick = (
  ctx: ServerContext,
  submitted: string,
  fallbackAgent: string,
): {
  readonly pick: AgentModelPick;
  readonly agentId: string;
  readonly runtime: AgentRuntime | undefined;
  readonly modelValue: string;
} => {
  const pick = decodeAgentModelValue(submitted);
  const agentId = pick.kind === "pick" ? pick.agent : fallbackAgent;
  return {
    pick,
    agentId,
    runtime: ctx.agents.find((entry) => entry.id === agentId),
    modelValue: pick.kind === "pick" ? pick.modelValue : "",
  };
};

// The combined picker behind the lazy fragment: every served agent
// contributes an optgroup (its default entry plus its catalogue).
// Resolving a catalogue may spawn the agent binary, so this powers only
// the fragment — never the New Session form, which must render
// instantly. `submitted` carries a rejected submit's combined value so
// the selection survives; a value that no longer decodes to a served
// agent falls back to the default agent's default.
const combinedModelPicker = async (
  ctx: ServerContext,
  submitted: string | undefined,
): Promise<ModelPicker | undefined> => {
  const groups = await Promise.all(
    ctx.agents.map(async (runtime): Promise<AgentModelGroup> => {
      const defaultSelection = runtime.models?.defaultSelection();
      return {
        agent: runtime.id,
        label: runtime.profile.agentName,
        defaultLabel:
          defaultSelection === undefined ? "" : modelLabel(defaultSelection),
        choices: (await runtime.models?.choices()) ?? [],
      };
    }),
  );
  // A single served agent with nothing pickable (no choices, no readable
  // default) renders no field: the slot swaps the hidden placeholder, as
  // a bare single-agent server always has. Several agents always pick —
  // the default entries are the agent choice.
  const nothingPickable = groups.every(
    (group) => group.choices.length === 0 && group.defaultLabel === "",
  );
  if (nothingPickable && groups.length === 1) return undefined;
  const { pick, runtime } = resolveAgentPick(
    ctx,
    submitted ?? "",
    ctx.defaultAgent.id,
  );
  return {
    groups,
    selected:
      pick.kind === "pick" && runtime !== undefined
        ? encodeAgentModelValue(pick.agent, pick.modelValue)
        : encodeAgentModelValue(ctx.defaultAgent.id, ""),
  };
};

// Cheap sync gate (config reads, never a catalogue spawn) deciding
// whether the form renders the lazy slot at all: with several agents the
// pick itself names one; a single agent renders a field only when it has
// a readable default (a bare single-agent server has nothing to pick).
const showsModelPicker = (ctx: ServerContext): boolean =>
  ctx.agents.length > 1 ||
  ctx.agents.some(
    (runtime) => runtime.models?.defaultSelection() !== undefined,
  );

// The forms' `modelPicker` prop: slot options when the gate passes,
// absent (the form renders no picker) otherwise. `submitted` restores a
// rejected submit's selection.
const modelPickerOpts = (
  ctx: ServerContext,
  submitted?: string,
): { submitted?: string } | undefined =>
  showsModelPicker(ctx) ? { submitted } : undefined;

// Everything a rejected submit needs to re-render the form without
// losing typed work.
type NewSessionDetailOpts = {
  error?: string;
  workingDir?: string;
  prompt?: string;
  /** The rejected submit's combined model value, restored as the
   * picker's preselection. */
  model?: string;
};

// Reads the cron database's jobs for the Scheduled runs section. A
// store broken by an external edit must not take the page down.
const safeCronJobs = (ctx: ServerContext): CronJobConfig[] => {
  if (ctx.cronDb === undefined) return [];
  try {
    return listCronJobs(ctx.cronDb, ctx.defaultAgent.id);
  } catch (err) {
    console.error(`cron: could not read jobs for the UI: ${errorMessage(err)}`);
    return [];
  }
};

const newSessionDetail = (
  ctx: ServerContext,
  { error, workingDir, prompt = "", model }: NewSessionDetailOpts = {},
): Child => {
  const db = ctx.prompts;
  const prompts = db !== undefined ? listPrompts(db) : [];
  const categories = db !== undefined ? listCategories(db) : [];
  return (
    <NewSessionForm
      agentName={ctx.agentNames}
      workingDir={workingDir ?? process.cwd()}
      dirs={ctx.listDirs()}
      error={error}
      prompt={prompt}
      prompts={prompts}
      categories={categories}
      modelPicker={modelPickerOpts(ctx, model)}
      jobs={safeCronJobs(ctx)}
    />
  );
};

export {
  combinedModelPicker,
  modelPickerOpts,
  newSessionDetail,
  render,
  renderNotFound,
  resolveAgentPick,
  showsModelPicker,
  sidebarEntries,
};
