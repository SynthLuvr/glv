import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Fragment } from "hono/jsx";
import { jobNameFor, untagCronSession } from "../../cron-sessions.js";
import { displayName, parseMessage, pendingTool } from "../../format/index.js";
import { removeMember } from "../../groups/db.js";
import { clearPending, getHandle, stop } from "../../runner/index.js";
import type { SessionRow } from "../../sessions.js";
import { ModelSelect } from "../../views/new-session.js";
import { SessionTitleWrap } from "../../views/Rename.js";
import { SessionList } from "../../views/Sidebar.js";
import { PromptBar, Transcript } from "../../views/transcript.js";
import { ServerContext, VIEWER_FILTER } from "../context.js";
import { fieldString, firstString, parseForm } from "../forms.js";
import { extractIds, isHtmxRequest, queryValue, sendHtml } from "../http.js";
import { canonicalWorkingDir, type SessionOperations } from "../operations.js";
import { expandHome } from "../paths.js";
import {
  combinedModelPicker,
  newSessionDetail,
  render,
  renderNotFound,
  sidebarEntries,
} from "../render.js";
import { activeRunPrompt } from "../session.js";
import { activeSessionIds } from "../status.js";
import { deleteTempDir, deleteUploads } from "../uploads.js";

const registerSessionRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
  ops: SessionOperations,
): void => {
  const sessionsAll = () => ctx.sessions.listSessions(VIEWER_FILTER);

  const NEW_SESSION_TITLE = "New Session — GLV";
  const sessionTitle = (name: string): string => `${displayName(name)} — GLV`;

  // Shared archive/delete landing: the New Session form in #detail-pane,
  // with the URL kept in step so a refresh doesn't hit the removed
  // session (404).
  const newSessionLanding = (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("HX-Push-Url", "/sessions/new");
    return render(
      request,
      reply,
      ctx,
      sessionsAll(),
      undefined,
      newSessionDetail(ctx),
      {
        refreshSidebar: true,
        title: NEW_SESSION_TITLE,
      },
    );
  };

  // The sidebar-list fragment returned by the rename and archive routes;
  // `oob` renders it as an out-of-band swap alongside another fragment.
  const sessionList = (sessions: SessionRow[], oob = false) => (
    <SessionList
      entries={sidebarEntries(ctx, sessions)}
      selectedId={undefined}
      runningIds={activeSessionIds(ctx.runner)}
      oob={oob}
      count={sessions.length}
    />
  );

  // Renders a full <Transcript> (messages + run handle) inside the standard
  // page shell.
  const renderSession = (
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    session: SessionRow,
    {
      prompt,
      refreshSidebar = false,
      includeRun = true,
      uploadError,
    }: {
      prompt?: string;
      refreshSidebar?: boolean;
      includeRun?: boolean;
      uploadError?: string;
    } = {},
  ): FastifyReply => {
    const messages = ctx.sessions.listMessages(id).map(parseMessage);
    const cronJob =
      ctx.cronDb !== undefined ? jobNameFor(ctx.cronDb, id) : undefined;
    const runtime = ctx.agentOf(id);
    return render(
      request,
      reply,
      ctx,
      sessionsAll(),
      id,
      <Transcript
        agentName={runtime?.profile.agentName ?? ctx.agentNames}
        session={session}
        messages={messages}
        run={includeRun ? getHandle(ctx.runner, id) : undefined}
        prompt={prompt}
        uploadError={uploadError}
        cronJob={cronJob}
      />,
      { refreshSidebar, title: sessionTitle(session.name) },
    );
  };

  app.get("/", (request, reply) =>
    render(
      request,
      reply,
      ctx,
      sessionsAll(),
      undefined,
      newSessionDetail(ctx),
    ),
  );

  // Registered before the /sessions/:id wildcard so "new" and "model-picker"
  // read as literal segments rather than session ids.
  app.get("/sessions/new", (request, reply) => {
    const workingDir = queryValue(request, "working_dir") || undefined;
    return render(
      request,
      reply,
      ctx,
      sessionsAll(),
      undefined,
      newSessionDetail(ctx, { workingDir }),
      { title: NEW_SESSION_TITLE },
    );
  });

  // Lazy fragment behind the picker slot: resolving the catalogue may
  // spawn the agent binary, so the form renders instantly and swaps this in
  // once it lands. One combined select — every served agent's default
  // entry and models, the pick naming both. A no-picker result still swaps
  // a hidden placeholder — htmx skips empty response bodies, which would
  // strand the loading slot.
  app.get("/sessions/model-picker", async (request, reply) => {
    const picker = await combinedModelPicker(
      ctx,
      queryValue(request, "submitted"),
    );
    if (picker === undefined)
      return sendHtml(reply, <span class="model-picker-empty" hidden />);
    return sendHtml(reply, <ModelSelect picker={picker} />);
  });

  app.post("/sessions", async (request, reply) => {
    const sessions = sessionsAll();
    const body = await parseForm(request);
    const bodyField = (key: string): string => firstString(body[key]);
    const prompt = bodyField("prompt");

    // Every rejection re-renders the form with the submitted prompt and
    // schedule values restored — scheduling is an alternate submit, and
    // nothing typed may be lost either way.
    const rejectForm = (error: string, status: number): FastifyReply =>
      render(
        request,
        reply,
        ctx,
        sessions,
        undefined,
        newSessionDetail(ctx, {
          error,
          workingDir: canonicalWorkingDir(expandHome(bodyField("working_dir"))),
          prompt,
          model: bodyField("model"),
        }),
        { status, title: NEW_SESSION_TITLE },
      );

    const result = await ops.startSession(body);
    if (!result.ok) return rejectForm(result.error, result.status);
    const { sessionId, session } = result;

    // The transcript swaps into #detail-pane; push the new session's URL
    // so the address bar (and a refresh) match what is on screen.
    reply.header("HX-Push-Url", `/sessions/${sessionId}`);
    return renderSession(request, reply, sessionId, session, {
      prompt,
      refreshSidebar: true,
    });
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", (request, reply) => {
    const id = request.params.id;
    const session = ctx.sessions.getSession(id);
    if (session === undefined) return renderNotFound(request, reply, ctx, id);
    // ?sidebar=1 (set by the stream's done handler) requests an out-of-band
    // sidebar refresh so a freshly renamed session no longer shows the stale
    // "CLI session" placeholder.
    return renderSession(request, reply, id, session, {
      refreshSidebar: queryValue(request, "sidebar") === "1",
    });
  });

  // Targeted prompt-bar fragment swap (status transition only). Lets the
  // client swap just the form — not the whole transcript — when a run ends.
  app.get<{ Params: { id: string } }>(
    "/sessions/:id/prompt-bar",
    (request, reply) => {
      const id = request.params.id;
      const session = ctx.sessions.getSession(id);
      if (session === undefined) return renderNotFound(request, reply, ctx, id);
      const run = getHandle(ctx.runner, id);
      const tool =
        run?.status === "running"
          ? pendingTool(ctx.sessions.listMessages(id).map(parseMessage))
          : undefined;
      return sendHtml(
        reply,
        <PromptBar
          agentName={ctx.agentOf(id)?.profile.agentName ?? ctx.agentNames}
          sessionId={id}
          run={run}
          pendingTool={tool}
        />,
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/archive",
    (request, reply) => {
      const id = request.params.id;
      // Stop an in-flight run first: sweeping the temp working dir out from
      // under a live agent (or deleting uploads its prompt references) leaves
      // the run writing into deleted directories.
      stop(ctx.runner, id);
      ctx.sessions.archiveSessions([id]);
      deleteUploads(ctx.dataDirName, id);
      deleteTempDir(ctx.dataDirName, id);
      return newSessionLanding(request, reply);
    },
  );

  // Archive only hides a session; delete destroys every record of it — the
  // flavor's own store, glv's group and cron sidecars, the run's uploads
  // and temp dir. Unknown ids 404 rather than "succeeding" invisibly.
  app.post<{ Params: { id: string } }>(
    "/sessions/:id/delete",
    (request, reply) => {
      const id = request.params.id;
      if (ctx.sessions.getSession(id) === undefined)
        return renderNotFound(request, reply, ctx, id);
      stop(ctx.runner, id);
      ctx.sessions.deleteSessions([id]);
      if (ctx.groups !== undefined) removeMember(ctx.groups, id);
      if (ctx.cronDb !== undefined) untagCronSession(ctx.cronDb, id);
      deleteUploads(ctx.dataDirName, id);
      deleteTempDir(ctx.dataDirName, id);
      return newSessionLanding(request, reply);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/rename",
    async (request, reply) => {
      const id = request.params.id;
      const body = await parseForm(request);
      const name = fieldString(body, "name");
      const from = body.from === "sidebar" ? "sidebar" : "header";
      ctx.sessions.renameSession(id, name);
      const updated = ctx.sessions.getSession(id);
      if (updated === undefined) return renderNotFound(request, reply, ctx, id);
      const sessions = sessionsAll();
      if (from === "sidebar") return sendHtml(reply, sessionList(sessions));
      if (!isHtmxRequest(request))
        return renderSession(request, reply, id, updated);
      return sendHtml(
        reply,
        <Fragment>
          <SessionTitleWrap session={updated} />
          {sessionList(sessions, true)}
        </Fragment>,
      );
    },
  );

  app.post("/sessions/archive", async (request, reply) => {
    const body = await parseForm(request);
    ctx.sessions.archiveSessions(extractIds(body.id));
    return sendHtml(reply, sessionList(sessionsAll()));
  });

  // Prompt runner endpoints

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/prompt",
    async (request, reply) => {
      const id = request.params.id;
      const body = await parseForm(request);
      const result = await ops.queueFollowUp(id, body);

      if (!result.ok) {
        if (result.status === 404)
          return renderNotFound(request, reply, ctx, id);
        // Validation failures (upload, location, empty prompt) surface as
        // the bar's error hint so the user can retry.
        const session = ctx.sessions.getSession(id);
        if (session === undefined)
          return renderNotFound(request, reply, ctx, id);
        return renderSession(request, reply, id, session, {
          uploadError: result.error,
        });
      }

      return renderSession(request, reply, id, result.session, {
        prompt: result.activePrompt,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/queue/cancel",
    (request, reply) => {
      const id = request.params.id;
      const session = ctx.sessions.getSession(id);
      if (session === undefined) return renderNotFound(request, reply, ctx, id);

      clearPending(ctx.runner, id);
      const run = getHandle(ctx.runner, id);
      return renderSession(request, reply, id, session, {
        prompt: activeRunPrompt(run),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/stop",
    (request, reply) => {
      const id = request.params.id;
      const result = ops.stopSession(id);
      if (!result.ok) return renderNotFound(request, reply, ctx, id);
      return renderSession(request, reply, id, result.session, {
        includeRun: false,
      });
    },
  );
};

export { registerSessionRoutes };
