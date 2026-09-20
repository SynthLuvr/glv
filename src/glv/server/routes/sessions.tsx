import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Fragment } from "hono/jsx";
import { jobNameFor, untagCronSession } from "../../cron-sessions.js";
import { displayName, parseMessage, pendingTool } from "../../format/index.js";
import { pullRepo } from "../../git.js";
import { removeMember } from "../../groups/db.js";
import { type EstablishOutcome, withCreateLock } from "../../launch.js";
import { modelUnavailableError } from "../../models.js";
import type { SavedPrompt } from "../../prompts/db.js";
import { bumpUsage, listPrompts } from "../../prompts/db.js";
import {
  clearPending,
  enqueueOrQueue,
  getHandle,
  stop,
} from "../../runner/index.js";
import type { SessionRow } from "../../sessions.js";
import { ModelSelect } from "../../views/new-session.js";
import { SessionTitleWrap } from "../../views/Rename.js";
import { SessionList } from "../../views/Sidebar.js";
import { PromptBar, Transcript } from "../../views/transcript.js";
import { ServerContext, VIEWER_FILTER } from "../context.js";
import { fieldString, parseForm } from "../forms.js";
import { extractIds, isHtmxRequest, queryValue, sendHtml } from "../http.js";
import { expandHome } from "../paths.js";
import {
  modelPicker,
  newSessionDetail,
  render,
  renderNotFound,
  sidebarEntries,
} from "../render.js";
import { activeRunPrompt } from "../session.js";
import { activeSessionIds } from "../status.js";
import {
  buildUploadContext,
  collectFiles,
  createTempDir,
  deleteTempDir,
  deleteUploads,
  removeDir,
  saveUploads,
  tagDir,
  uploadErrorMessage,
} from "../uploads.js";

// parseForm yields an array per repeated field; take the first string.
const firstString = (val: unknown): string => {
  if (Array.isArray(val))
    return typeof val[0] === "string" ? val[0].trim() : "";
  return typeof val === "string" ? val.trim() : "";
};

// The agent persists working_dir in canonical form, so the submitted dir
// must be normalized here or the new-session discovery poll compares
// against a different spelling, never finds the row, and stops the healthy
// run at its timeout — this also keeps the spawn cwd and the per-directory
// create lock on one spelling. Empty stays empty: resolve("") would invent
// the server's cwd.
const canonicalWorkingDir = (raw: string): string =>
  raw === "" ? raw : resolve(raw);

const registerSessionRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  const sessionsAll = () => ctx.sessions.listSessions(VIEWER_FILTER);
  // The saved-prompt library powers the follow-up bar picker; empty when the
  // prompts store is disabled so the picker shows its "no prompts" message.
  const libraryPrompts = (): SavedPrompt[] =>
    ctx.prompts !== undefined ? listPrompts(ctx.prompts) : [];

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
    return render(
      request,
      reply,
      ctx,
      sessionsAll(),
      id,
      <Transcript
        agentName={ctx.profile.agentName}
        session={session}
        messages={messages}
        run={includeRun ? getHandle(ctx.runner, id) : undefined}
        prompt={prompt}
        prompts={libraryPrompts()}
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
  // once it lands. A no-picker result still swaps a hidden placeholder —
  // htmx skips empty response bodies, which would strand the loading slot.
  app.get("/sessions/model-picker", async (request, reply) => {
    const picker = await modelPicker(ctx, queryValue(request, "submitted"));
    return sendHtml(
      reply,
      picker === undefined ? (
        <span class="model-picker-empty" hidden />
      ) : (
        <ModelSelect agentName={ctx.profile.agentName} picker={picker} />
      ),
    );
  });

  app.post("/sessions", async (request, reply) => {
    const sessions = sessionsAll();
    const body = await parseForm(request);
    const bodyField = (key: string): string => firstString(body[key]);

    const prompt = bodyField("prompt");
    const promptId = bodyField("prompt_id");
    const sessionMode = bodyField("session_mode");
    const modelProvider = bodyField("model_provider");
    const submittedWorkingDir = canonicalWorkingDir(
      expandHome(bodyField("working_dir")),
    );

    const files = collectFiles(body.uploads);

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
          workingDir: submittedWorkingDir,
          prompt,
          modelProvider,
        }),
        { status, title: NEW_SESSION_TITLE },
      );

    if (prompt === "")
      return rejectForm("A prompt is required to start a session.", 422);

    // The dropdown listed render-time config; resolve the pick against a
    // fresh read in case goose's config changed since the form was served.
    const model = ctx.models?.resolve(modelProvider);
    if (modelProvider !== "" && model === undefined)
      return rejectForm(modelUnavailableError(ctx.profile.agentName), 422);

    if (
      sessionMode !== "temp" &&
      (submittedWorkingDir === "" || !existsSync(submittedWorkingDir))
    )
      return rejectForm("That working directory does not exist.", 422);

    const tempWorkingDir =
      sessionMode === "temp"
        ? createTempDir(ctx.profile.dataDirName)
        : undefined;
    const workingDir = tempWorkingDir ?? submittedWorkingDir;

    // Save uploaded files into GLV's private storage and append their
    // absolute paths to the prompt so the agent can read them.
    let uploadDir: string | undefined;
    let fullPrompt = prompt;
    if (files.length > 0)
      try {
        const saved = await saveUploads(files, ctx.profile.dataDirName);
        fullPrompt = prompt + buildUploadContext(saved.paths);
        uploadDir = saved.dir;
      } catch (err) {
        return rejectForm(uploadErrorMessage(err), 422);
      }

    // Pre-tag cleanup for a failed attempt: these dirs are untagged, so
    // the archive-time sweep would never collect them.
    const removeAttemptDirs = (): void => {
      if (uploadDir !== undefined) removeDir(uploadDir);
      if (tempWorkingDir !== undefined) removeDir(tempWorkingDir);
    };

    const establishSession = async (): Promise<EstablishOutcome> =>
      withCreateLock(
        ctx.createLocks,
        workingDir,
        async (): Promise<EstablishOutcome> => {
          // Inside the per-directory lock so concurrent starts can't race the pull.
          await pullRepo(workingDir, ctx.runGit);
          const handle = ctx.launcher.startNew(workingDir, fullPrompt, model);

          const sessionId = await ctx.launcher.awaitNew(
            handle,
            workingDir,
            ctx.pollTimeoutMs,
          );
          if (sessionId === undefined) {
            stop(ctx.runner, handle);
            return {
              ok: false,
              status: 502,
              error: ctx.profile.sessionTimeoutError,
            };
          }
          return ctx.launcher.establish(
            handle,
            sessionId,
            "Another session is starting in that directory. Please try again.",
          );
        },
      );

    let result: EstablishOutcome;
    try {
      result = await establishSession();
    } catch (err) {
      // The lock helper only swallows *prior* attempts' rejections; a fresh
      // throw from this attempt must still clean up or its dirs leak forever.
      removeAttemptDirs();
      throw err;
    }

    if (!result.ok) {
      removeAttemptDirs();
      return rejectForm(result.error, result.status);
    }
    const { sessionId, session } = result;

    // Tag the upload dir with the real session id so cleanup finds it when
    // the session is archived.
    if (uploadDir !== undefined) tagDir(uploadDir, sessionId);
    if (tempWorkingDir !== undefined) tagDir(tempWorkingDir, sessionId);

    // A "Run" from a saved prompt tags the submit with the prompt id; bump
    // usage stats only once the run has actually been established.
    if (promptId !== "" && ctx.prompts !== undefined)
      bumpUsage(ctx.prompts, promptId);

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
          agentName={ctx.profile.agentName}
          sessionId={id}
          run={run}
          prompts={libraryPrompts()}
          workingDir={session.working_dir}
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
      deleteUploads(ctx.profile.dataDirName, id);
      deleteTempDir(ctx.profile.dataDirName, id);
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
      deleteUploads(ctx.profile.dataDirName, id);
      deleteTempDir(ctx.profile.dataDirName, id);
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
      const session = ctx.sessions.getSession(id);
      if (session === undefined) return renderNotFound(request, reply, ctx, id);

      const body = await parseForm(request);
      const prompt = firstString(body.prompt);
      const files = collectFiles(body.uploads);

      // Session id is known, so tag the upload dir immediately for cleanup.
      let fullPrompt = prompt;
      let uploadError: string | undefined;
      if (files.length > 0)
        try {
          const saved = await saveUploads(files, ctx.profile.dataDirName);
          fullPrompt = prompt + buildUploadContext(saved.paths);
          tagDir(saved.dir, id);
        } catch (err) {
          uploadError = uploadErrorMessage(err);
        }

      // Render the submitted prompt only when it started right away; queued
      // prompts surface as QueuedPrompt cards via the handle, so passing the
      // text here too would double-display it. Skip enqueuing entirely when an
      // upload failed so the user can retry.
      let activePrompt: string | undefined;
      if (prompt !== "" && uploadError === undefined) {
        const { queued } = enqueueOrQueue(
          ctx.runner,
          id,
          fullPrompt,
          session.working_dir,
        );
        if (!queued) activePrompt = prompt;
      }

      const run = getHandle(ctx.runner, id);
      activePrompt ??= activeRunPrompt(run);

      return renderSession(request, reply, id, session, {
        prompt: activePrompt,
        uploadError,
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
      stop(ctx.runner, id);
      const session = ctx.sessions.getSession(id);
      if (session === undefined) return renderNotFound(request, reply, ctx, id);
      return renderSession(request, reply, id, session, { includeRun: false });
    },
  );
};

export { registerSessionRoutes };
