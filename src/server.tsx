import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { type Child, Fragment, type PropsWithChildren } from "hono/jsx";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import type { SessionFilter, SessionRow } from "./db.js";
import {
  archiveSessions,
  getSession,
  listMessages,
  listSessions,
  sessionIdsInDir,
} from "./db.js";
import { parseMessage } from "./format.js";
import type { Runner } from "./runner.js";
import {
  enqueue,
  enqueueNew,
  generateTempKey,
  getHandle,
  isTerminalStatus,
  rekey,
  stop,
} from "./runner.js";
import { Layout } from "./views/Layout.js";
import { SessionList, Sidebar } from "./views/Sidebar.js";
import { renderStreamLine } from "./views/stream-line.js";
import {
  NewSessionForm,
  NotFoundDetail,
  renderMessage,
  Transcript,
} from "./views/Transcript.js";

const VIEWER_FILTER: SessionFilter = {
  type: "user",
  limit: 100,
  includeArchived: false,
};

const SESSION_TIMEOUT_ERROR =
  "goose did not create a session in time. Is the goose binary available?";

// Resolved via import.meta so the asset is found regardless of launch directory.
const htmxSource = readFileSync(
  fileURLToPath(import.meta.resolve("htmx.org/dist/htmx.min.js")),
  "utf8",
);

const readAsset = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const Shell = ({
  sessions,
  selectedId,
  children,
}: PropsWithChildren<{
  sessions: SessionRow[];
  selectedId: string | undefined;
}>) => (
  <Layout title="Goose Sessions">
    <div class="app">
      <Sidebar sessions={sessions} selectedId={selectedId} />
      <main class="detail" id="detail-pane">
        {children}
      </main>
    </div>
  </Layout>
);

const isHtmxRequest = (c: Context): boolean =>
  c.req.header("HX-Request") === "true";

const extractIds = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
};

// htmx navigation swaps only the detail pane so an in-progress bulk selection
// survives. Mutations additionally refresh the sidebar out-of-band.
const render = (
  c: Context,
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
) =>
  isHtmxRequest(c)
    ? c.html(
        <Fragment>
          {detail}
          {refreshSidebar && (
            <SessionList sessions={sessions} selectedId={undefined} oob />
          )}
        </Fragment>,
        status,
      )
    : c.html(
        <Shell sessions={sessions} selectedId={selectedId}>
          {detail}
        </Shell>,
        status,
      );

const serveAsset = (c: Context, body: string, contentType: string) =>
  c.body(body, 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400",
  });

// Writing to a closed stream (client disconnect) throws; guard each emission.
const emit = async (
  stream: SSEStreamingApi,
  event: string,
  data: string,
): Promise<boolean> => {
  if (stream.aborted) return false;
  try {
    await stream.writeSSE({ event, data });
    return true;
  } catch {
    return false;
  }
};

const flushLines = async (
  stream: SSEStreamingApi,
  lines: string[],
  from: number,
): Promise<boolean> => {
  for (let i = from; i < lines.length; i++) {
    const html = renderStreamLine(lines[i]);
    if (html !== "" && !(await emit(stream, "line", html))) return false;
  }
  return true;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const pollForSessionId = async (
  db: DatabaseSync,
  workingDir: string,
  known: Set<string>,
  timeoutMs = 10000,
  intervalMs = 50,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sessionIdsInDir(db, workingDir).find((id) => !known.has(id));
    if (found !== undefined) return found;
    await sleep(intervalMs);
  }
  return undefined;
};

const listHomeDirs = (home: string = homedir()): string[] =>
  readdirSync(home, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(home, entry.name))
    .sort();

type AppEnv = { Variables: { runner: Runner } };

const createApp = (
  db: DatabaseSync,
  runner: Runner,
  opts: {
    tailPollMs?: number;
    /** Bounds poll iterations so tests can drain the stream. */
    maxTailPolls?: number;
    pollTimeoutMs?: number;
    listDirs?: () => string[];
  } = {},
): Hono<AppEnv> => {
  const tailPollMs = opts.tailPollMs ?? 1000;
  const maxTailPolls = opts.maxTailPolls ?? Infinity;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 10000;
  const listDirs = opts.listDirs ?? listHomeDirs;
  // Inside createApp so serve can build assets before these reads.
  const appCss = readAsset("../dist/app.css");
  const sidebarScript = readAsset("../dist/sidebar.js");
  const streamScript = readAsset("../dist/stream.js");
  const themeScript = readAsset("../dist/theme.js");
  const markdownCopyScript = readAsset("../dist/markdown-copy.js");
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("runner", runner);
    await next();
  });

  const renderNotFound = (c: Context, id: string) =>
    render(
      c,
      listSessions(db, VIEWER_FILTER),
      undefined,
      <NotFoundDetail id={id} />,
      { status: 404 },
    );

  const newSessionDetail = (error?: string): Child => (
    <NewSessionForm
      workingDir={process.cwd()}
      dirs={listDirs()}
      error={error}
    />
  );

  app.get("/htmx.min.js", (c) =>
    serveAsset(c, htmxSource, "application/javascript; charset=utf-8"),
  );
  app.get("/app.css", (c) => serveAsset(c, appCss, "text/css; charset=utf-8"));
  app.get("/sidebar.js", (c) =>
    serveAsset(c, sidebarScript, "application/javascript; charset=utf-8"),
  );
  app.get("/stream.js", (c) =>
    serveAsset(c, streamScript, "application/javascript; charset=utf-8"),
  );
  app.get("/theme.js", (c) =>
    serveAsset(c, themeScript, "application/javascript; charset=utf-8"),
  );
  app.get("/markdown-copy.js", (c) =>
    serveAsset(c, markdownCopyScript, "application/javascript; charset=utf-8"),
  );

  app.get("/", (c) => {
    const sessions = listSessions(db, VIEWER_FILTER);
    return render(c, sessions, undefined, newSessionDetail());
  });

  // Registered before the /sessions/:id wildcard so "new" is treated as a
  // literal segment rather than a session id.
  app.get("/sessions/new", (c) => {
    const sessions = listSessions(db, VIEWER_FILTER);
    return render(c, sessions, undefined, newSessionDetail());
  });

  app.post("/sessions", async (c) => {
    const sessions = listSessions(db, VIEWER_FILTER);
    const reject = (error: string, status: ContentfulStatusCode) =>
      render(c, sessions, undefined, newSessionDetail(error), { status });

    const body = await c.req.parseBody();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const workingDir =
      typeof body.working_dir === "string" ? body.working_dir.trim() : "";

    if (prompt === "")
      return reject("A prompt is required to start a session.", 422);
    if (workingDir === "" || !existsSync(workingDir))
      return reject("That working directory does not exist.", 422);

    const tempKey = generateTempKey();
    const known = new Set(sessionIdsInDir(db, workingDir));
    enqueueNew(runner, tempKey, prompt, workingDir);

    const realId = await pollForSessionId(db, workingDir, known, pollTimeoutMs);
    if (realId === undefined) {
      stop(runner, tempKey);
      return reject(SESSION_TIMEOUT_ERROR, 502);
    }

    rekey(runner, tempKey, realId);
    const session = getSession(db, realId);
    if (session === undefined) {
      stop(runner, realId);
      return reject(SESSION_TIMEOUT_ERROR, 502);
    }

    return render(
      c,
      listSessions(db, VIEWER_FILTER),
      realId,
      <Transcript
        session={session}
        messages={listMessages(db, realId).map(parseMessage)}
        run={getHandle(runner, realId)}
        prompt={prompt}
      />,
      { refreshSidebar: true },
    );
  });

  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const sessions = listSessions(db, VIEWER_FILTER);
    const session = getSession(db, id);
    if (session === undefined)
      return render(c, sessions, undefined, <NotFoundDetail id={id} />, {
        status: 404,
      });
    const messages = listMessages(db, id).map(parseMessage);
    // Surfaced so a re-render after the stream reflects the run's outcome.
    const run = getHandle(runner, id);
    return render(
      c,
      sessions,
      id,
      <Transcript session={session} messages={messages} run={run} />,
    );
  });

  app.post("/sessions/:id/archive", (c) => {
    const id = c.req.param("id");
    archiveSessions(db, [id]);
    const sessions = listSessions(db, VIEWER_FILTER);
    return render(c, sessions, undefined, newSessionDetail(), {
      refreshSidebar: true,
    });
  });

  app.post("/sessions/archive", async (c) => {
    const body = (await c.req.parseBody({ all: true })) as Record<
      string,
      unknown
    >;
    archiveSessions(db, extractIds(body.id));
    const sessions = listSessions(db, VIEWER_FILTER);
    return c.html(<SessionList sessions={sessions} selectedId={undefined} />);
  });

  // Prompt runner endpoints

  app.post("/sessions/:id/prompt", async (c) => {
    const id = c.req.param("id");
    const session = getSession(db, id);
    if (session === undefined) return renderNotFound(c, id);

    const body = await c.req.parseBody();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (prompt !== "")
      try {
        enqueue(runner, id, prompt, session.working_dir);
      } catch {
        // Already running or queued — fall through to render current state.
      }

    const run = getHandle(runner, id);
    const messages = listMessages(db, id).map(parseMessage);
    return render(
      c,
      listSessions(db, VIEWER_FILTER),
      id,
      <Transcript
        session={session}
        messages={messages}
        run={run}
        prompt={prompt || undefined}
      />,
    );
  });

  app.get("/sessions/:id/stream", (c) => {
    const id = c.req.param("id");
    if (getSession(db, id) === undefined)
      return c.text("Session not found", 404);

    return streamSSE(c, async (stream) => {
      const handle = getHandle(runner, id);

      // Idle or terminal: flush catch-up output, then close.
      if (handle === undefined || isTerminalStatus(handle.status)) {
        if (handle !== undefined) await flushLines(stream, handle.lines, 0);
        await emit(stream, "done", handle?.status ?? "idle");
        return;
      }

      if (
        !(await emit(
          stream,
          "status",
          JSON.stringify({
            status: handle.status,
            queuePosition: handle.queuePosition,
          }),
        ))
      )
        return;

      let sent = 0;
      while (!isTerminalStatus(handle.status)) {
        if (stream.aborted) return;
        if (!(await flushLines(stream, handle.lines, sent))) return;
        sent = handle.lines.length;
        await stream.sleep(50);
      }

      await flushLines(stream, handle.lines, sent);
      await emit(
        stream,
        "status",
        JSON.stringify({
          status: handle.status,
          error: handle.error ?? null,
        }),
      );
      await emit(stream, "done", handle.status);
    });
  });

  // Polls the shared database for messages appended by any writer (terminal,
  // desktop, another CLI) and streams only rows not already rendered at page
  // load. Used only for sessions the web app isn't actively running.
  app.get("/sessions/:id/tail", (c) => {
    const id = c.req.param("id");
    if (getSession(db, id) === undefined)
      return c.text("Session not found", 404);

    return streamSSE(c, async (stream) => {
      let sent = listMessages(db, id).length;
      let polls = 0;
      while (!stream.aborted && polls < maxTailPolls) {
        polls++;
        await stream.sleep(tailPollMs);
        if (stream.aborted) return;
        const rows = listMessages(db, id);
        if (rows.length <= sent) continue;
        const messages = rows.map(parseMessage);
        for (let i = sent; i < messages.length; i++) {
          const html = renderMessage(messages[i]);
          if (html !== "" && !(await emit(stream, "append", html))) return;
        }
        sent = messages.length;
      }
    });
  });

  app.post("/sessions/:id/stop", (c) => {
    const id = c.req.param("id");
    stop(runner, id);
    const session = getSession(db, id);
    if (session === undefined) return renderNotFound(c, id);
    const messages = listMessages(db, id).map(parseMessage);
    return render(
      c,
      listSessions(db, VIEWER_FILTER),
      id,
      <Transcript session={session} messages={messages} />,
    );
  });

  return app;
};

export { createApp, listHomeDirs };
