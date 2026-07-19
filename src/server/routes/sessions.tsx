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
  type SessionRow,
  sessionIdsInDir,
} from "../../db.js";
import { parseMessage } from "../../format/index.js";
import {
  type CloneJob,
  clonePathFor,
  generateCloneJobId,
  parseOwnerRepo,
} from "../../gh.js";
import { bumpUsage } from "../../prompts/db.js";
import {
  clearPending,
  enqueueNew,
  enqueueOrQueue,
  generateTempKey,
  getHandle,
  rekey,
  stop,
} from "../../runner/index.js";
import {
  CloningView,
  NotFoundDetail,
  type SourceType,
} from "../../views/new-session.js";
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
  errorMessage,
  expandHome,
  extractIds,
  isHtmxRequest,
  pollForSessionId,
  withCreateLock,
} from "../util.js";

const registerSessionRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  const sessionsAll = () => listSessions(ctx.db, VIEWER_FILTER);

  app.get("/", (c) =>
    render(c, ctx, sessionsAll(), undefined, newSessionDetail(ctx)),
  );

  // Registered before the /sessions/:id wildcard so "new" is treated as a
  // literal segment rather than a session id.
  app.get("/sessions/new", (c) =>
    render(c, ctx, sessionsAll(), undefined, newSessionDetail(ctx)),
  );

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
        newSessionDetail(
          ctx,
          error,
          src,
          repoVal || undefined,
          branchVal || undefined,
        ),
        { status },
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
      );
    }

    // Working directory flow
    const workingDir = expandHome(
      typeof body.working_dir === "string" ? body.working_dir.trim() : "",
    );
    if (workingDir === "" || !existsSync(workingDir))
      return rejectForm("That working directory does not exist.", 422);

    const tempKey = generateTempKey();

    type EstablishResult =
      | { ok: true; realId: string; session: SessionRow }
      | { ok: false; status: ContentfulStatusCode; error: string };

    const result = await withCreateLock(
      ctx.createLocks,
      workingDir,
      async (): Promise<EstablishResult> => {
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

        if (!rekey(ctx.runner, tempKey, realId)) {
          stop(ctx.runner, tempKey);
          return {
            ok: false,
            status: 409,
            error:
              "Another session is starting in that directory. Please try again.",
          };
        }
        const session = getSession(ctx.db, realId);
        if (session === undefined) {
          stop(ctx.runner, realId);
          return { ok: false, status: 502, error: SESSION_TIMEOUT_ERROR };
        }
        return { ok: true, realId, session };
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
      />,
      { refreshSidebar: true },
    );
  });

  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const sessions = sessionsAll();
    const session = getSession(ctx.db, id);
    if (session === undefined)
      return render(c, ctx, sessions, undefined, <NotFoundDetail id={id} />, {
        status: 404,
      });
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
      <Transcript session={session} messages={messages} run={run} />,
      { refreshSidebar: c.req.query("sidebar") === "1" },
    );
  });

  app.post("/sessions/:id/archive", (c) => {
    const id = c.req.param("id");
    archiveSessions(ctx.db, [id]);
    return render(c, ctx, sessionsAll(), undefined, newSessionDetail(ctx), {
      refreshSidebar: true,
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
        <Transcript session={updated} messages={messages} run={run} />,
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
      />,
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
      />,
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
      <Transcript session={session} messages={messages} />,
    );
  });
};

export { registerSessionRoutes };
