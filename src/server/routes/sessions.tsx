import { existsSync } from "node:fs";
import { type Hono } from "hono";
import { Fragment } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  archiveSessions,
  getSession,
  listMessages,
  listSessions,
  renameSession,
  sessionIdsInDir,
} from "../../db.js";
import { displayName, parseMessage } from "../../format/index.js";
import {
  type CloneJob,
  clonePathFor,
  generateCloneJobId,
  parseOwnerRepo,
} from "../../gh.js";
import type { SavedPrompt } from "../../prompts/db.js";
import { bumpUsage, listPrompts } from "../../prompts/db.js";
import {
  clearPending,
  enqueueNew,
  enqueueOrQueue,
  generateTempKey,
  getHandle,
  stop,
} from "../../runner/index.js";
import { CloningView, type SourceType } from "../../views/new-session.js";
import { SessionTitleWrap } from "../../views/Rename.js";
import { SessionList } from "../../views/Sidebar.js";
import { Transcript } from "../../views/transcript.js";
import {
  AppEnv,
  SESSION_TIMEOUT_ERROR,
  ServerContext,
  VIEWER_FILTER,
} from "../context.js";
import { newSessionDetail, render, renderNotFound } from "../render.js";
import { activeSessionIds } from "../status.js";
import {
  activeRunPrompt,
  type EstablishOutcome,
  errorMessage,
  establishSession,
  expandHome,
  extractIds,
  isHtmxRequest,
  pollForSessionId,
  withCreateLock,
} from "../util.js";

const registerSessionRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  const sessionsAll = () => listSessions(ctx.db, VIEWER_FILTER);
  // The saved-prompt library powers the follow-up bar picker; empty when the
  // prompts store is disabled so the picker shows its "no prompts" message.
  const libraryPrompts = (): SavedPrompt[] =>
    ctx.prompts !== undefined ? listPrompts(ctx.prompts) : [];

  const NEW_SESSION_TITLE = "New Session — Goose Log Viewer";
  const sessionTitle = (name: string): string =>
    `${displayName(name)} — Goose Log Viewer`;

  app.get("/", (c) =>
    render(c, ctx, sessionsAll(), undefined, newSessionDetail(ctx)),
  );

  // Registered before the /sessions/:id wildcard so "new" is treated as a
  // literal segment rather than a session id.
  app.get("/sessions/new", (c) => {
    const workingDir = c.req.query("working_dir") || undefined;
    return render(
      c,
      ctx,
      sessionsAll(),
      undefined,
      newSessionDetail(ctx, { workingDir }),
      { title: NEW_SESSION_TITLE },
    );
  });

  app.post("/sessions", async (c) => {
    const sessions = sessionsAll();
    const body = await c.req.parseBody();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const source: SourceType =
      typeof body.source === "string" && body.source === "github"
        ? "github"
        : "working_dir";
    const repoVal = typeof body.repo === "string" ? body.repo.trim() : "";
    const branchVal = typeof body.branch === "string" ? body.branch.trim() : "";
    const promptId =
      typeof body.prompt_id === "string" ? body.prompt_id.trim() : "";
    const workingDir = expandHome(
      typeof body.working_dir === "string" ? body.working_dir.trim() : "",
    );

    const rejectForm = (
      error: string,
      status: ContentfulStatusCode,
      src: SourceType = source,
    ) =>
      render(
        c,
        ctx,
        sessions,
        undefined,
        newSessionDetail(ctx, {
          error,
          source: src,
          repo: repoVal || undefined,
          branch: branchVal || undefined,
          workingDir,
        }),
        { status, title: NEW_SESSION_TITLE },
      );

    if (prompt === "")
      return rejectForm("A prompt is required to start a session.", 422);

    if (source === "github") {
      if (repoVal === "" || branchVal === "")
        return rejectForm(
          "A repository and branch are required for GitHub mode.",
          422,
          "github",
        );

      let parsed: { owner: string; repo: string };
      let clonePath: string;
      try {
        parsed = parseOwnerRepo(repoVal);
        clonePath = clonePathFor(parsed.owner, parsed.repo);
      } catch {
        return rejectForm(
          "Invalid repository format. Expected owner/name.",
          422,
          "github",
        );
      }
      const jobId = generateCloneJobId();
      const job: CloneJob = {
        jobId,
        createdAt: Date.now(),
        repo: repoVal,
        branch: branchVal,
        clonePath,
        prompt,
        status: "cloning",
        error: undefined,
        tempKey: undefined,
        known: undefined,
        runStartedAt: undefined,
      };
      ctx.cloneJobs.set(jobId, job);

      const runCloneJob = async (): Promise<void> => {
        await ctx.gh.materialise(
          parsed.owner,
          parsed.repo,
          branchVal,
          clonePath,
        );
        job.tempKey = generateTempKey();
        job.known = new Set(sessionIdsInDir(ctx.db, clonePath));
        job.runStartedAt = Date.now();
        enqueueNew(ctx.runner, job.tempKey, prompt, clonePath);
        if (promptId !== "" && ctx.prompts !== undefined)
          bumpUsage(ctx.prompts, promptId);
        job.status = "done";
      };

      void runCloneJob().catch((err: unknown) => {
        job.status = "error";
        job.error = errorMessage(err);
      });

      return render(
        c,
        ctx,
        sessions,
        undefined,
        <CloningView
          repo={repoVal}
          branch={branchVal}
          jobId={jobId}
          cloning={true}
        />,
        { title: NEW_SESSION_TITLE },
      );
    }

    // Working directory flow
    if (workingDir === "" || !existsSync(workingDir))
      return rejectForm("That working directory does not exist.", 422);

    const tempKey = generateTempKey();

    const result = await withCreateLock(
      ctx.createLocks,
      workingDir,
      async (): Promise<EstablishOutcome> => {
        const known = new Set(sessionIdsInDir(ctx.db, workingDir));
        enqueueNew(ctx.runner, tempKey, prompt, workingDir);

        const realId = await pollForSessionId(
          ctx.db,
          workingDir,
          known,
          ctx.pollTimeoutMs,
        );
        if (realId === undefined) {
          stop(ctx.runner, tempKey);
          return { ok: false, status: 502, error: SESSION_TIMEOUT_ERROR };
        }
        return establishSession(
          ctx,
          tempKey,
          realId,
          "Another session is starting in that directory. Please try again.",
        );
      },
    );

    if (!result.ok) return rejectForm(result.error, result.status);
    const { realId, session } = result;

    // A "Run" from a saved prompt tags the submit with the prompt id; bump
    // usage stats only once the run has actually been established.
    if (promptId !== "" && ctx.prompts !== undefined)
      bumpUsage(ctx.prompts, promptId);

    return render(
      c,
      ctx,
      listSessions(ctx.db, VIEWER_FILTER),
      realId,
      <Transcript
        session={session}
        messages={listMessages(ctx.db, realId).map(parseMessage)}
        run={getHandle(ctx.runner, realId)}
        prompt={prompt}
        prompts={libraryPrompts()}
      />,
      { refreshSidebar: true, title: sessionTitle(session.name) },
    );
  });

  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const sessions = sessionsAll();
    const session = getSession(ctx.db, id);
    if (session === undefined) return renderNotFound(c, ctx, id);
    const messages = listMessages(ctx.db, id).map(parseMessage);
    // Surfaced so a re-render after the stream reflects the run's outcome.
    const run = getHandle(ctx.runner, id);
    // ?sidebar=1 (set by the stream's done handler) requests an out-of-band
    // sidebar refresh so a freshly renamed session no longer shows the stale
    // "CLI session" placeholder.
    return render(
      c,
      ctx,
      sessions,
      id,
      <Transcript
        session={session}
        messages={messages}
        run={run}
        prompts={libraryPrompts()}
      />,
      {
        refreshSidebar: c.req.query("sidebar") === "1",
        title: sessionTitle(session.name),
      },
    );
  });

  app.post("/sessions/:id/archive", (c) => {
    const id = c.req.param("id");
    archiveSessions(ctx.db, [id]);
    return render(c, ctx, sessionsAll(), undefined, newSessionDetail(ctx), {
      refreshSidebar: true,
      title: NEW_SESSION_TITLE,
    });
  });

  app.post("/sessions/:id/rename", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name : "";
    const from = body.from === "sidebar" ? "sidebar" : "header";
    renameSession(ctx.db, id, name);
    const updated = getSession(ctx.db, id);
    if (updated === undefined) return renderNotFound(c, ctx, id);
    const sessions = sessionsAll();
    if (from === "sidebar")
      return c.html(
        <SessionList
          sessions={sessions}
          selectedId={undefined}
          runningIds={activeSessionIds(ctx.runner)}
        />,
      );
    if (!isHtmxRequest(c)) {
      const messages = listMessages(ctx.db, id).map(parseMessage);
      const run = getHandle(ctx.runner, id);
      return render(
        c,
        ctx,
        sessions,
        id,
        <Transcript
          session={updated}
          messages={messages}
          run={run}
          prompts={libraryPrompts()}
        />,
        { title: sessionTitle(updated.name) },
      );
    }
    return c.html(
      <Fragment>
        <SessionTitleWrap session={updated} />
        <SessionList
          sessions={sessions}
          selectedId={undefined}
          runningIds={activeSessionIds(ctx.runner)}
          oob
        />
      </Fragment>,
    );
  });

  app.post("/sessions/archive", async (c) => {
    const body = await c.req.parseBody({ all: true });
    archiveSessions(ctx.db, extractIds(body.id));
    const sessions = sessionsAll();
    return c.html(
      <SessionList
        sessions={sessions}
        selectedId={undefined}
        runningIds={activeSessionIds(ctx.runner)}
      />,
    );
  });

  // Prompt runner endpoints

  app.post("/sessions/:id/prompt", async (c) => {
    const id = c.req.param("id");
    const session = getSession(ctx.db, id);
    if (session === undefined) return renderNotFound(c, ctx, id);

    const body = await c.req.parseBody();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    // Render the submitted prompt only when it started right away; queued
    // prompts surface as QueuedPrompt cards via the handle, so passing the
    // text here too would double-display it.
    let activePrompt: string | undefined;
    if (prompt !== "") {
      const { queued } = enqueueOrQueue(
        ctx.runner,
        id,
        prompt,
        session.working_dir,
      );
      if (!queued) activePrompt = prompt;
    }

    const run = getHandle(ctx.runner, id);
    activePrompt ??= activeRunPrompt(run);

    const messages = listMessages(ctx.db, id).map(parseMessage);
    return render(
      c,
      ctx,
      listSessions(ctx.db, VIEWER_FILTER),
      id,
      <Transcript
        session={session}
        messages={messages}
        run={run}
        prompt={activePrompt}
        prompts={libraryPrompts()}
      />,
      { title: sessionTitle(session.name) },
    );
  });

  app.post("/sessions/:id/queue/cancel", (c) => {
    const id = c.req.param("id");
    const session = getSession(ctx.db, id);
    if (session === undefined) return renderNotFound(c, ctx, id);

    clearPending(ctx.runner, id);
    const run = getHandle(ctx.runner, id);
    const messages = listMessages(ctx.db, id).map(parseMessage);
    return render(
      c,
      ctx,
      listSessions(ctx.db, VIEWER_FILTER),
      id,
      <Transcript
        session={session}
        messages={messages}
        run={run}
        prompt={activeRunPrompt(run)}
        prompts={libraryPrompts()}
      />,
      { title: sessionTitle(session.name) },
    );
  });

  app.post("/sessions/:id/stop", (c) => {
    const id = c.req.param("id");
    stop(ctx.runner, id);
    const session = getSession(ctx.db, id);
    if (session === undefined) return renderNotFound(c, ctx, id);
    const messages = listMessages(ctx.db, id).map(parseMessage);
    return render(
      c,
      ctx,
      listSessions(ctx.db, VIEWER_FILTER),
      id,
      <Transcript
        session={session}
        messages={messages}
        prompts={libraryPrompts()}
      />,
      { title: sessionTitle(session.name) },
    );
  });
};

export { registerSessionRoutes };
