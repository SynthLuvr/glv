import { type Context, type Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  getSession,
  listMessages,
  listSessions,
  sessionIdsInDir,
} from "../../db.js";
import { parseMessage } from "../../format/index.js";
import { getHandle, rekey, stop } from "../../runner/index.js";
import { CloningView } from "../../views/new-session.js";
import { Transcript } from "../../views/transcript.js";
import {
  AppEnv,
  SESSION_TIMEOUT_ERROR,
  ServerContext,
  VIEWER_FILTER,
} from "../context.js";
import { newSessionDetail, render } from "../render.js";
import { errorMessage, withCreateLock } from "../util.js";

const ghErrorResponse = (c: Context<AppEnv>, err: unknown) =>
  c.json({ ok: false, error: errorMessage(err) }, 502);

const registerGithubRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  app.get("/github/repos", async (c) => {
    try {
      return c.json({ ok: true, repos: await ctx.gh.listRepos() });
    } catch (err) {
      return ghErrorResponse(c, err);
    }
  });

  app.get("/github/repos/:owner/:repo/branches", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    try {
      const info = await ctx.gh.listBranches(owner, repo);
      return c.json({ ok: true, ...info });
    } catch (err) {
      return ghErrorResponse(c, err);
    }
  });

  app.get("/github/clone-status/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const job = ctx.cloneJobs.get(jobId);
    const sessions = listSessions(ctx.db, VIEWER_FILTER);

    if (job === undefined)
      return render(
        c,
        ctx,
        sessions,
        undefined,
        newSessionDetail(ctx, { error: "Clone job not found." }),
        { status: 404 },
      );

    const waitView = (cloning: boolean) =>
      render(
        c,
        ctx,
        sessions,
        undefined,
        <CloningView
          repo={job.repo}
          branch={job.branch}
          jobId={job.jobId}
          cloning={cloning}
        />,
      );
    const failForm = (error: string, status: ContentfulStatusCode) =>
      render(
        c,
        ctx,
        sessions,
        undefined,
        newSessionDetail(ctx, {
          error,
          source: "github",
          repo: job.repo,
          branch: job.branch,
        }),
        { status },
      );

    // `cloning` only toggles the spinner's status-line copy.
    if (job.status === "cloning") return waitView(true);

    if (job.status === "error") {
      ctx.cloneJobs.delete(jobId);
      return failForm(job.error ?? "Clone failed.", 422);
    }

    // Goose run enqueued; poll for the new session id.
    if (
      job.tempKey === undefined ||
      job.known === undefined ||
      job.runStartedAt === undefined
    )
      return waitView(false);

    if (Date.now() - job.runStartedAt > ctx.pollTimeoutMs) {
      stop(ctx.runner, job.tempKey);
      ctx.cloneJobs.delete(jobId);
      return failForm(SESSION_TIMEOUT_ERROR, 502);
    }

    const known = job.known;
    const tempKey = job.tempKey;
    const realId = sessionIdsInDir(ctx.db, job.clonePath).find(
      (id) => !known.has(id),
    );
    if (realId === undefined) return waitView(false);

    const claimed = await withCreateLock(ctx.createLocks, job.clonePath, () =>
      rekey(ctx.runner, tempKey, realId),
    );
    if (!claimed) {
      stop(ctx.runner, tempKey);
      ctx.cloneJobs.delete(jobId);
      return failForm(
        "Another session is starting in that repository. Please try again.",
        409,
      );
    }

    ctx.cloneJobs.delete(jobId);
    const session = getSession(ctx.db, realId);
    if (session === undefined) {
      stop(ctx.runner, realId);
      return failForm(SESSION_TIMEOUT_ERROR, 502);
    }

    return render(
      c,
      ctx,
      listSessions(ctx.db, VIEWER_FILTER),
      realId,
      <Transcript
        session={session}
        messages={listMessages(ctx.db, realId).map(parseMessage)}
        run={getHandle(ctx.runner, realId)}
        prompt={job.prompt}
      />,
      { refreshSidebar: true },
    );
  });
};

export { registerGithubRoutes };
