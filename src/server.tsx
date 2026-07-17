import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { type Child, Fragment, type PropsWithChildren } from "hono/jsx";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import {
  authMiddleware,
  COOKIE_NAME,
  setSessionCookie,
} from "./auth/middleware.js";
import {
  type AuthService,
  type RpConfig,
  type VerifyResult,
} from "./auth/service.js";
import type { SessionFilter, SessionRow } from "./db.js";
import {
  archiveSessions,
  getSession,
  listMessages,
  listSessions,
  renameSession,
  sessionIdsInDir,
} from "./db.js";
import { fmtRelative, type ParsedMessage, parseMessage } from "./format.js";
import { type CommandRunner, resolvePrState, STATE_LABEL } from "./pr.js";
import type { RunHandle, Runner, RunStatus } from "./runner.js";
import {
  enqueue,
  enqueueNew,
  generateTempKey,
  getHandle,
  isTerminalStatus,
  rekey,
  stop,
} from "./runner.js";
import { LoginPage, RegisterPage } from "./views/Auth.js";
import { Layout } from "./views/Layout.js";
import { SessionTitleWrap } from "./views/Rename.js";
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

// Terminal handles linger in the registry; this filters them out so the
// sidebar only shows sessions that are queued or running.
const activeStatuses = (runner: Runner): Map<string, RunStatus> =>
  new Map(
    [...runner.registry.entries()]
      .filter(([, h]) => !isTerminalStatus(h.status))
      .map(([id, h]) => [id, h.status]),
  );

const activeSessionIds = (runner: Runner): Set<string> =>
  new Set(activeStatuses(runner).keys());

const statusDeltas = (
  last: Map<string, RunStatus>,
  now: Map<string, RunStatus>,
): Array<[string, string]> => {
  const result: Array<[string, string]> = [];
  for (const [id, status] of now)
    if (last.get(id) !== status) result.push([id, status]);
  for (const [id] of last) if (!now.has(id)) result.push([id, "done"]);
  return result;
};

const Shell = ({
  sessions,
  selectedId,
  runningIds,
  logout = false,
  children,
}: PropsWithChildren<{
  sessions: SessionRow[];
  selectedId: string | undefined;
  runningIds: Set<string>;
  logout?: boolean;
}>) => (
  <Layout title="Goose Sessions">
    <div class="app">
      <Sidebar
        sessions={sessions}
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

const isHtmxRequest = (c: Context): boolean =>
  c.req.header("HX-Request") === "true";

const extractIds = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
};

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

const flushMessages = async (
  stream: SSEStreamingApi,
  messages: ParsedMessage[],
  from: number,
): Promise<boolean> => {
  for (let i = from; i < messages.length; i++) {
    const html = renderMessage(messages[i], i);
    if (html !== "" && !(await emit(stream, "append", html))) return false;
  }
  return true;
};

const emitStatus = async (
  stream: SSEStreamingApi,
  handle: RunHandle,
): Promise<boolean> =>
  emit(
    stream,
    "status",
    JSON.stringify({
      status: handle.status,
      queuePosition: handle.queuePosition,
    }),
  );

const emitMeta = async (
  stream: SSEStreamingApi,
  session: SessionRow,
): Promise<boolean> =>
  emit(
    stream,
    "meta",
    JSON.stringify({
      updated: fmtRelative(session.updated_at),
      updatedTitle: session.updated_at,
    }),
  );

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

// The new-session form submits ~, which Node will not expand itself.
const expandHome = (path: string, home: string = homedir()): string =>
  path === "~"
    ? home
    : path.startsWith("~/")
      ? join(home, path.slice(2))
      : path;

type AppEnv = { Variables: { runner: Runner } };

const createApp = (
  db: DatabaseSync,
  runner: Runner,
  opts: {
    tailPollMs?: number;
    /** Bounds poll iterations so tests can drain the stream. */
    maxTailPolls?: number;
    pollTimeoutMs?: number;
    /** Poll interval (ms) for the global status feed. */
    statusPollMs?: number;
    /** Bounds status-feed poll iterations so tests can drain the stream. */
    maxStatusPolls?: number;
    listDirs?: () => string[];
    auth?: AuthService;
    rpName?: string;
    rpIdOverride?: string;
    /** Subprocess runner for `gh pr view`; tests inject a fake. */
    runPrState?: CommandRunner;
  } = {},
): Hono<AppEnv> => {
  const tailPollMs = opts.tailPollMs ?? 1000;
  const maxTailPolls = opts.maxTailPolls ?? Infinity;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 10000;
  const statusPollMs = opts.statusPollMs ?? 1000;
  const maxStatusPolls = opts.maxStatusPolls ?? Infinity;
  const listDirs = opts.listDirs ?? listHomeDirs;
  // Inside createApp so serve can build assets before these reads.
  const appCss = readAsset("../dist/app.css");
  const sidebarScript = readAsset("../dist/sidebar.js");
  const streamScript = readAsset("../dist/stream.js");
  const themeScript = readAsset("../dist/theme.js");
  const markdownCopyScript = readAsset("../dist/markdown-copy.js");
  const renameScript = readAsset("../dist/rename.js");
  const passkeyScript = readAsset("../dist/passkey.js");
  const auth = opts.auth;
  const app = new Hono<AppEnv>();
  // Auth gate sits first: every non-public request must carry a valid
  // session before any other middleware or route runs.
  if (auth !== undefined) app.use("*", authMiddleware(auth));
  app.use(async (c, next) => {
    c.set("runner", runner);
    await next();
  });

  const showLogout = auth !== undefined;
  // htmx navigation swaps only the detail pane so an in-progress bulk
  // selection survives. Mutations additionally refresh the sidebar
  // out-of-band.
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
  ) => {
    const runningIds = activeSessionIds(runner);
    return isHtmxRequest(c)
      ? c.html(
          <Fragment>
            {detail}
            {refreshSidebar && (
              <SessionList
                sessions={sessions}
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
            sessions={sessions}
            selectedId={selectedId}
            runningIds={runningIds}
            logout={showLogout}
          >
            {detail}
          </Shell>,
          status,
        );
  };

  const rpFromContext = (c: Context): RpConfig => {
    const url = new URL(c.req.url);
    return {
      rpName: opts.rpName ?? "Goose Log Viewer",
      rpID: opts.rpIdOverride ?? (url.hostname || "localhost"),
      expectedOrigin: url.origin,
    };
  };

  const finishAuth = (
    c: Context,
    result: VerifyResult,
    fallbackError: string,
  ) => {
    if (result.verified && result.token !== undefined) {
      setSessionCookie(c, result.token);
      return c.json({ verified: true });
    }
    return c.json(
      { verified: false, error: result.error ?? fallbackError },
      400,
    );
  };

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

  app.get("/assets/htmx.min.js", (c) =>
    serveAsset(c, htmxSource, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/app.css", (c) =>
    serveAsset(c, appCss, "text/css; charset=utf-8"),
  );
  app.get("/assets/sidebar.js", (c) =>
    serveAsset(c, sidebarScript, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/stream.js", (c) =>
    serveAsset(c, streamScript, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/theme.js", (c) =>
    serveAsset(c, themeScript, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/markdown-copy.js", (c) =>
    serveAsset(c, markdownCopyScript, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/rename.js", (c) =>
    serveAsset(c, renameScript, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/passkey.js", (c) =>
    serveAsset(c, passkeyScript, "application/javascript; charset=utf-8"),
  );

  if (auth !== undefined) {
    app.get("/auth/register", (c) => {
      if (auth.isClaimed()) return c.redirect("/auth/login", 302);
      return c.html(<RegisterPage />);
    });

    app.get("/auth/login", (c) => {
      if (!auth.isClaimed()) return c.redirect("/auth/register", 302);
      return c.html(<LoginPage />);
    });

    app.get("/auth/register/options", async (c) => {
      if (auth.isClaimed())
        return c.json({ error: "Registration is closed." }, 403);
      return c.json(await auth.registrationOptions(rpFromContext(c)));
    });

    app.post("/auth/register/verify", async (c) => {
      if (auth.isClaimed())
        return c.json(
          { verified: false, error: "Registration is closed." },
          403,
        );
      const result = await auth.verifyRegistration(
        rpFromContext(c),
        await c.req.json(),
      );
      return finishAuth(c, result, "Verification failed.");
    });

    app.get("/auth/login/options", async (c) =>
      c.json(await auth.loginOptions(rpFromContext(c))),
    );

    app.post("/auth/login/verify", async (c) => {
      const result = await auth.verifyLogin(
        rpFromContext(c),
        await c.req.json(),
      );
      return finishAuth(c, result, "Login failed.");
    });

    app.post("/auth/logout", (c) => {
      auth.logout(getCookie(c, COOKIE_NAME));
      deleteCookie(c, COOKIE_NAME, { path: "/" });
      return c.redirect("/auth/login", 302);
    });
  }

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
    const workingDir = expandHome(
      typeof body.working_dir === "string" ? body.working_dir.trim() : "",
    );

    if (prompt === "")
      return reject("A prompt is required to start a session.", 422);
    if (workingDir === "" || !existsSync(workingDir))
      return reject("That working directory does not exist.", 422);

    const tempKey = generateTempKey();
    const known = new Set(sessionIdsInDir(db, workingDir));
    enqueueNew(runner, tempKey, prompt, workingDir);

    const rejectTimeout = (key: string) => {
      stop(runner, key);
      return reject(SESSION_TIMEOUT_ERROR, 502);
    };
    const realId = await pollForSessionId(db, workingDir, known, pollTimeoutMs);
    if (realId === undefined) return rejectTimeout(tempKey);

    rekey(runner, tempKey, realId);
    const session = getSession(db, realId);
    if (session === undefined) return rejectTimeout(realId);

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
    // ?sidebar=1 (set by the stream's done handler) requests an out-of-band
    // sidebar refresh so a freshly renamed session no longer shows the stale
    // "CLI session" placeholder.
    return render(
      c,
      sessions,
      id,
      <Transcript session={session} messages={messages} run={run} />,
      { refreshSidebar: c.req.query("sidebar") === "1" },
    );
  });

  // Resolve live PR state via `gh` and return a colored badge for htmx to
  // swap in. Unknown state → empty body, so the chip degrades to a plain link.
  app.get("/sessions/:id/pr-state", async (c) => {
    const url = c.req.query("url") ?? "";
    const state = await resolvePrState(url, opts.runPrState);
    if (state === "unknown") return c.html("");
    return c.html(
      <span class={`pr-state pr-state-${state}`}>
        <span class="pr-dot" aria-hidden="true"></span>
        {STATE_LABEL[state]}
      </span>,
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

  app.post("/sessions/:id/rename", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name : "";
    const from = body.from === "sidebar" ? "sidebar" : "header";
    renameSession(db, id, name);
    const updated = getSession(db, id);
    if (updated === undefined) return renderNotFound(c, id);
    const sessions = listSessions(db, VIEWER_FILTER);
    if (from === "sidebar")
      return c.html(
        <SessionList
          sessions={sessions}
          selectedId={undefined}
          runningIds={activeSessionIds(runner)}
        />,
      );
    if (!isHtmxRequest(c)) {
      const messages = listMessages(db, id).map(parseMessage);
      const run = getHandle(runner, id);
      return render(
        c,
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
          runningIds={activeSessionIds(runner)}
          oob
        />
      </Fragment>,
    );
  });

  app.post("/sessions/archive", async (c) => {
    const body = (await c.req.parseBody({ all: true })) as Record<
      string,
      unknown
    >;
    archiveSessions(db, extractIds(body.id));
    const sessions = listSessions(db, VIEWER_FILTER);
    return c.html(
      <SessionList
        sessions={sessions}
        selectedId={undefined}
        runningIds={activeSessionIds(runner)}
      />,
    );
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

      if (!(await emitStatus(stream, handle))) return;

      // Surface mid-run transitions (e.g. queued → running) so the client
      // isn't left on a stale status until the terminal re-render.
      let lastStatus = handle.status;
      let sent = 0;
      while (!isTerminalStatus(handle.status)) {
        if (stream.aborted) return;
        if (handle.status !== lastStatus) {
          if (!(await emitStatus(stream, handle))) return;
          lastStatus = handle.status;
        }
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

  // Polls the shared database for messages appended or updated by any writer
  // (terminal, desktop, another CLI). Streams only deltas. Used only for
  // sessions the web app isn't actively running.
  app.get("/sessions/:id/tail", (c) => {
    const id = c.req.param("id");
    if (getSession(db, id) === undefined)
      return c.text("Session not found", 404);

    return streamSSE(c, async (stream) => {
      // Snapshot content_json to detect in-place edits, not just appends.
      let snapshots = listMessages(db, id).map((row) => row.content_json);
      let polls = 0;
      while (!stream.aborted && polls < maxTailPolls) {
        polls++;
        await stream.sleep(tailPollMs);
        if (stream.aborted) return;
        const rows = listMessages(db, id);
        const messages = rows.map(parseMessage);
        const common = Math.min(snapshots.length, rows.length);
        let changed = false;

        // Re-render rows whose content changed since the last poll.
        for (let i = 0; i < common; i++) {
          if (rows[i].content_json === snapshots[i]) continue;
          const html = renderMessage(messages[i], i);
          if (
            html !== "" &&
            !(await emit(stream, "replace", JSON.stringify({ index: i, html })))
          )
            return;
          changed = true;
        }

        if (rows.length > snapshots.length) {
          if (!(await flushMessages(stream, messages, snapshots.length)))
            return;
          changed = true;
        }

        snapshots = rows.map((row) => row.content_json);

        if (!changed) continue;
        const session = getSession(db, id);
        if (session === undefined) continue;
        if (!(await emitMeta(stream, session))) return;
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

  // Streams status deltas for all active runs — not just the one the detail
  // pane watches — to drive the sidebar's running indicators.
  app.get("/events/status", (c) =>
    streamSSE(c, async (stream) => {
      let last = activeStatuses(runner);
      let polls = 0;

      if (!(await emit(stream, "sync", JSON.stringify([...last.keys()]))))
        return;

      while (!stream.aborted && polls < maxStatusPolls) {
        polls++;
        await stream.sleep(statusPollMs);
        if (stream.aborted) return;

        const now = activeStatuses(runner);
        for (const [id, status] of statusDeltas(last, now))
          if (
            !(await emit(
              stream,
              "status",
              JSON.stringify({ sessionId: id, status }),
            ))
          )
            return;
        last = now;
      }
    }),
  );

  return app;
};

export { createApp, expandHome, listHomeDirs };
