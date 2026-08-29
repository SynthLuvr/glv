import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Context, type Hono } from "hono";
import { Fragment } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { displayName, parseMessage } from "../../format/index.js";
import { pullRepo } from "../../git.js";
import { type EstablishOutcome, withCreateLock } from "../../launch.js";
import type { SavedPrompt } from "../../prompts/db.js";
import { bumpUsage, listPrompts } from "../../prompts/db.js";
import {
  clearPending,
  enqueueOrQueue,
  getHandle,
  stop,
} from "../../runner/index.js";
import type { SessionRow } from "../../sessions.js";
import { SessionTitleWrap } from "../../views/Rename.js";
import { SessionList } from "../../views/Sidebar.js";
import { PromptBar, Transcript } from "../../views/transcript.js";
import { ServerContext, VIEWER_FILTER } from "../context.js";
import { extractIds, isHtmxRequest } from "../http.js";
import { expandHome } from "../paths.js";
import {
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

// parseBody({ all: true }) returns an array per field; take the first string.
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

const registerSessionRoutes = (app: Hono, ctx: ServerContext): void => {
  const sessionsAll = () => ctx.sessions.listSessions(VIEWER_FILTER);
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
      uploadError,
    }: {
      prompt?: string;
      refreshSidebar?: boolean;
      includeRun?: boolean;
      uploadError?: string;
    } = {},
  ) => {
    const messages = ctx.sessions.listMessages(id).map(parseMessage);
    return render(
      c,
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
    const fieldString = (key: string): string => firstString(body[key]);

    const prompt = fieldString("prompt");
    const promptId = fieldString("prompt_id");
    const sessionMode = fieldString("session_mode");
    const modelProvider = fieldString("model_provider");
    const submittedWorkingDir = canonicalWorkingDir(
      expandHome(fieldString("working_dir")),
    );

    const files = collectFiles(body.uploads);

    const rejectForm = (error: string, status: ContentfulStatusCode) =>
      render(
        c,
        ctx,
        sessions,
        undefined,
        newSessionDetail(ctx, {
          error,
          workingDir: submittedWorkingDir,
          modelProvider,
        }),
        { status, title: NEW_SESSION_TITLE },
      );

    if (prompt === "")
      return rejectForm("A prompt is required to start a session.", 422);

    // The dropdown listed render-time config; resolve the pick against a
    // fresh read in case goose's config changed since the form was served.
    const model =
      modelProvider === "" ? undefined : ctx.models?.resolve(modelProvider);
    if (modelProvider !== "" && model === undefined)
      return rejectForm(
        `That model is no longer configured in ${ctx.profile.agentName}. Pick another from the list.`,
        422,
      );

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

    return renderSession(c, sessionId, session, {
      prompt,
      refreshSidebar: true,
    });
  });

  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = ctx.sessions.getSession(id);
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
    const session = ctx.sessions.getSession(id);
    if (session === undefined) return renderNotFound(c, ctx, id);
    const run = getHandle(ctx.runner, id);
    return c.html(
      <PromptBar
        agentName={ctx.profile.agentName}
        sessionId={id}
        run={run}
        prompts={libraryPrompts()}
        workingDir={session.working_dir}
      />,
    );
  });

  app.post("/sessions/:id/archive", (c) => {
    const id = c.req.param("id");
    // Stop an in-flight run first: sweeping the temp working dir out from
    // under a live agent (or deleting uploads its prompt references) leaves
    // the run writing into deleted directories.
    stop(ctx.runner, id);
    ctx.sessions.archiveSessions([id]);
    deleteUploads(ctx.profile.dataDirName, id);
    deleteTempDir(ctx.profile.dataDirName, id);
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
    ctx.sessions.renameSession(id, name);
    const updated = ctx.sessions.getSession(id);
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
    ctx.sessions.archiveSessions(extractIds(body.id));
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
    const session = ctx.sessions.getSession(id);
    if (session === undefined) return renderNotFound(c, ctx, id);

    const body = await c.req.parseBody({ all: true });
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

    return renderSession(c, id, session, {
      prompt: activePrompt,
      uploadError,
    });
  });

  app.post("/sessions/:id/queue/cancel", (c) => {
    const id = c.req.param("id");
    const session = ctx.sessions.getSession(id);
    if (session === undefined) return renderNotFound(c, ctx, id);

    clearPending(ctx.runner, id);
    const run = getHandle(ctx.runner, id);
    return renderSession(c, id, session, { prompt: activeRunPrompt(run) });
  });

  app.post("/sessions/:id/stop", (c) => {
    const id = c.req.param("id");
    stop(ctx.runner, id);
    const session = ctx.sessions.getSession(id);
    if (session === undefined) return renderNotFound(c, ctx, id);
    return renderSession(c, id, session, { includeRun: false });
  });
};

export { registerSessionRoutes };
