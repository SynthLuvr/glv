import { existsSync } from "node:fs";
import { type Context, type Hono } from "hono";
import { Fragment } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  archiveSessions,
  getSession,
  listMessages,
  listSessions,
  renameSession,
  type SessionRow,
} from "../../db.js";
import { displayName, parseMessage } from "../../format/index.js";
import { pullRepo } from "../../git.js";
import type { SavedPrompt } from "../../prompts/db.js";
import { bumpUsage, listPrompts } from "../../prompts/db.js";
import {
  clearPending,
  enqueueOrQueue,
  getHandle,
  stop,
} from "../../runner/index.js";
import { SessionTitleWrap } from "../../views/Rename.js";
import { SessionList } from "../../views/Sidebar.js";
import { PromptBar, Transcript } from "../../views/transcript.js";
import {
  SESSION_TIMEOUT_ERROR,
  ServerContext,
  VIEWER_FILTER,
} from "../context.js";
import { extractIds, isHtmxRequest } from "../http.js";
import { expandHome } from "../paths.js";
import {
  newSessionDetail,
  render,
  renderNotFound,
  sidebarEntries,
} from "../render.js";
import {
  activeRunPrompt,
  type EstablishOutcome,
  establishSession,
  pollForSessionId,
  prepareNewSession,
  withCreateLock,
} from "../session.js";
import { activeSessionIds } from "../status.js";
import {
  buildUploadContext,
  deleteUploadDir,
  deleteUploads,
  saveUploads,
  tagUploadDir,
  UploadError,
} from "../uploads.js";

const registerSessionRoutes = (app: Hono, ctx: ServerContext): void => {
  const sessionsAll = () => listSessions(ctx.db, VIEWER_FILTER);
  // The saved-prompt library powers the follow-up bar picker; empty when the
  // prompts store is disabled so the picker shows its "no prompts" message.
  const libraryPrompts = (): SavedPrompt[] =>
    ctx.prompts !== undefined ? listPrompts(ctx.prompts) : [];

  const NEW_SESSION_TITLE = "New Session — GLV";
  const sessionTitle = (name: string): string => `${displayName(name)} — GLV`;

  // Renders a full <Transcript> (messages + run handle) inside the standard
  // page shell.
  const renderSession = (
    c: Context,
    id: string,
    session: SessionRow,
    {
      prompt,
      refreshSidebar = false,
      includeRun = true,
    }: {
      prompt?: string;
      refreshSidebar?: boolean;
      includeRun?: boolean;
    } = {},
  ) => {
    const messages = listMessages(ctx.db, id).map(parseMessage);
    return render(
      c,
      ctx,
      sessionsAll(),
      id,
      <Transcript
        session={session}
        messages={messages}
        run={includeRun ? getHandle(ctx.runner, id) : undefined}
        prompt={prompt}
        prompts={libraryPrompts()}
      />,
      { refreshSidebar, title: sessionTitle(session.name) },
    );
  };

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
    const body = await c.req.parseBody({ all: true });
    const fieldString = (key: string): string => {
      const val = body[key];
      if (Array.isArray(val))
        return typeof val[0] === "string" ? val[0].trim() : "";
      return typeof val === "string" ? val.trim() : "";
    };

    const prompt = fieldString("prompt");
    const promptId = fieldString("prompt_id");
    const workingDir = expandHome(fieldString("working_dir"));

    const rawUploads = body.uploads;
    const files: File[] = [];
    if (Array.isArray(rawUploads)) {
      for (const v of rawUploads)
        if (v instanceof File && v.size > 0) files.push(v);
    } else if (rawUploads instanceof File && rawUploads.size > 0)
      files.push(rawUploads);

    const rejectForm = (error: string, status: ContentfulStatusCode) =>
      render(
        c,
        ctx,
        sessions,
        undefined,
        newSessionDetail(ctx, { error, workingDir }),
        { status, title: NEW_SESSION_TITLE },
      );

    if (prompt === "")
      return rejectForm("A prompt is required to start a session.", 422);

    if (workingDir === "" || !existsSync(workingDir))
      return rejectForm("That working directory does not exist.", 422);

    // Save uploaded files into GLV's private storage and append their
    // absolute paths to the prompt so goose can read them.
    let uploadDir: string | undefined;
    let fullPrompt = prompt;
    if (files.length > 0)
      try {
        const saved = await saveUploads(files);
        fullPrompt = prompt + buildUploadContext(saved.paths);
        uploadDir = saved.dir;
      } catch (err) {
        const msg =
          err instanceof UploadError
            ? err.message
            : "Failed to save uploaded files.";
        return rejectForm(msg, 422);
      }

    const result = await withCreateLock(
      ctx.createLocks,
      workingDir,
      async (): Promise<EstablishOutcome> => {
        // Inside the per-directory lock so concurrent starts can't race the pull.
        await pullRepo(workingDir, ctx.runGit);
        const { tempKey, known } = prepareNewSession(
          ctx,
          workingDir,
          fullPrompt,
        );

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

    if (!result.ok) {
      if (uploadDir !== undefined) deleteUploadDir(uploadDir);
      return rejectForm(result.error, result.status);
    }
    const { realId, session } = result;

    // Move uploads from the temp batch dir onto the real session id so
    // cleanup finds them when the session is archived.
    if (uploadDir !== undefined) tagUploadDir(uploadDir, realId);

    // A "Run" from a saved prompt tags the submit with the prompt id; bump
    // usage stats only once the run has actually been established.
    if (promptId !== "" && ctx.prompts !== undefined)
      bumpUsage(ctx.prompts, promptId);

    return renderSession(c, realId, session, {
      prompt,
      refreshSidebar: true,
    });
  });

  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = getSession(ctx.db, id);
    if (session === undefined) return renderNotFound(c, ctx, id);
    // ?sidebar=1 (set by the stream's done handler) requests an out-of-band
    // sidebar refresh so a freshly renamed session no longer shows the stale
    // "CLI session" placeholder.
    return renderSession(c, id, session, {
      refreshSidebar: c.req.query("sidebar") === "1",
    });
  });

  // Targeted prompt-bar fragment swap (status transition only). Lets the
  // client swap just the form — not the whole transcript — when a run ends.
  app.get("/sessions/:id/prompt-bar", (c) => {
    const id = c.req.param("id");
    const session = getSession(ctx.db, id);
    if (session === undefined) return renderNotFound(c, ctx, id);
    const run = getHandle(ctx.runner, id);
    return c.html(
      <PromptBar
        sessionId={id}
        run={run}
        prompts={libraryPrompts()}
        workingDir={session.working_dir}
      />,
    );
  });

  app.post("/sessions/:id/archive", (c) => {
    const id = c.req.param("id");
    archiveSessions(ctx.dbWritable, [id]);
    deleteUploads(id);
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
    renameSession(ctx.dbWritable, id, name);
    const updated = getSession(ctx.db, id);
    if (updated === undefined) return renderNotFound(c, ctx, id);
    const sessions = sessionsAll();
    if (from === "sidebar")
      return c.html(
        <SessionList
          entries={sidebarEntries(ctx, sessions)}
          selectedId={undefined}
          runningIds={activeSessionIds(ctx.runner)}
        />,
      );
    if (!isHtmxRequest(c)) return renderSession(c, id, updated);
    return c.html(
      <Fragment>
        <SessionTitleWrap session={updated} />
        <SessionList
          entries={sidebarEntries(ctx, sessions)}
          selectedId={undefined}
          runningIds={activeSessionIds(ctx.runner)}
          oob
        />
      </Fragment>,
    );
  });

  app.post("/sessions/archive", async (c) => {
    const body = await c.req.parseBody({ all: true });
    archiveSessions(ctx.dbWritable, extractIds(body.id));
    const sessions = sessionsAll();
    return c.html(
      <SessionList
        entries={sidebarEntries(ctx, sessions)}
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

    return renderSession(c, id, session, { prompt: activePrompt });
  });

  app.post("/sessions/:id/queue/cancel", (c) => {
    const id = c.req.param("id");
    const session = getSession(ctx.db, id);
    if (session === undefined) return renderNotFound(c, ctx, id);

    clearPending(ctx.runner, id);
    const run = getHandle(ctx.runner, id);
    return renderSession(c, id, session, { prompt: activeRunPrompt(run) });
  });

  app.post("/sessions/:id/stop", (c) => {
    const id = c.req.param("id");
    stop(ctx.runner, id);
    const session = getSession(ctx.db, id);
    if (session === undefined) return renderNotFound(c, ctx, id);
    return renderSession(c, id, session, { includeRun: false });
  });
};

export { registerSessionRoutes };
