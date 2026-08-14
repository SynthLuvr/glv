import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "@playwright/test";
import { mockBin } from "type-a-bin";
import { tryParseJson } from "../parse.js";
import { openMetaDb } from "../store/meta.js";
import { encodeWorkingDir } from "../store/working-dir.js";

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL DEFAULT 'owner',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS credentials (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  public_key  BLOB NOT NULL,
  counter     INTEGER NOT NULL,
  transports  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GLV = join(ROOT, "bin", "glv");

// tsx is resolved to an absolute loader path because the mock claude runs
// from a temp dir with no node_modules.
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const claudeMockScriptPath = fileURLToPath(
  new URL("./claude-mock-script.ts", import.meta.url),
);
const ghMockScriptPath = fileURLToPath(
  new URL("./gh-mock-script.ts", import.meta.url),
);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close(() => reject(new Error("could not bind a port")));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });

const waitForHttp = async (url: string, timeoutMs = 20000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline)
    try {
      const res = await fetch(url, { redirect: "manual" });
      await res.arrayBuffer();
      return;
    } catch (err) {
      lastErr = err;
      await sleep(150);
    }

  throw new Error(`server at ${url} never responded: ${String(lastErr)}`);
};

type SessionSeed = { id: string; name: string; workingDir: string };

// A content payload (plain string or claude content-block array), written
// verbatim into the transcript so transcript-rendering tests can seed rich
// transcripts.
type MessageSeed = {
  role: string;
  content: unknown;
  createdTimestamp?: number;
  messageId?: string;
};

type Databases = {
  projectsDir: string;
  metaDb: string;
  authDb: string;
  promptsDb: string;
  groupsDb: string;
  token: string;
};

type MockConfig = {
  /** Delay (ms) before the mock emits output, keeping a run "running". */
  sleepMs?: number;
  /** claude exit code; non-zero surfaces as a runner error. */
  exitCode?: number;
  /** NDJSON lines to emit (newline-joined); default is a single reply. */
  lines?: string[];
  /** Name written into a new session's ai-title line. */
  sessionName?: string;
  /** Pause (ms) between streamed lines so a tail fills incrementally. */
  lineDelayMs?: number;
  /** When set, persist each line to the session transcript as produced. */
  writeDb?: boolean;
  /** When set, writes claude's stdin (the full prompt) to this file path. */
  captureStdin?: string;
  /** When set, writes claude's working directory to this file path. */
  captureCwd?: string;
  /** When set, writes claude's argv (JSON string[]) to this file path. */
  captureArgs?: string;
  /** When set, claude spawns a long-lived descendant and writes its PID here. */
  spawnChild?: string;
};

type IntegrationEnv = {
  scratchDir: string;
  baseUrl: string;
  cookie: string;
  context: BrowserContext;
  dbs: Databases;
  /** GLV's private uploads directory (temp dir, cleaned up on test end). */
  uploadsDir: string;
  /** GLV's private temp working-directory area (cleaned up on test end). */
  tempDir: string;
  /** Reads stderr accumulated by the glv serve process (e.g. console.warn). */
  serverStderr: () => string;
  cleanup: () => Promise<void>;
};

// WAL-free: the projects dir is plain JSONL the mock claude appends to while
// the server reads. The auth row satisfies the WebAuthn gate without a real
// passkey: the returned token becomes the glv_session cookie.
const createDatabases = (scratchDir: string): Databases => {
  const projectsDir = join(scratchDir, "projects");
  mkdirSync(projectsDir, { recursive: true });

  const metaDb = join(scratchDir, "meta.db");
  openMetaDb(metaDb).close();

  const authDb = join(scratchDir, "auth.db");
  const adb = openAuthDbSeed(authDb);

  return {
    projectsDir,
    metaDb,
    authDb,
    promptsDb: join(scratchDir, "prompts.db"),
    groupsDb: join(scratchDir, "groups.db"),
    token: adb.token,
  };
};

const openAuthDbSeed = (dbPath: string): { token: string } => {
  const adb = new DatabaseSync(dbPath);
  adb.exec(AUTH_SCHEMA);
  const token = randomBytes(32).toString("base64url");
  adb
    .prepare("INSERT INTO users (id, username) VALUES (?, 'owner')")
    .run("owner-1");
  adb
    .prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) " +
        "VALUES (?, ?, datetime('now', '+1 day'), datetime('now'))",
    )
    .run(token, "owner-1");
  adb.close();
  return { token };
};

// The server reads fresh on every request, so sessions seeded here appear in
// the sidebar on the next page load without a restart. Staggered mtimes keep
// the newest-first sidebar order deterministic.
const insertSessions = (
  projectsRoot: string,
  sessions: SessionSeed[],
): void => {
  let ts = Date.now();
  for (const s of sessions) {
    const dir = join(projectsRoot, encodeWorkingDir(s.workingDir));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${s.id}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "ai-title",
        aiTitle: s.name,
        sessionId: s.id,
        cwd: s.workingDir,
        timestamp: new Date(ts).toISOString(),
      })}\n`,
    );
    utimesSync(path, new Date(ts), new Date(ts));
    ts += 1000;
  }
};

const findSessionFile = (
  projectsRoot: string,
  sessionId: string,
): string | undefined => {
  let dirs;
  try {
    dirs = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(projectsRoot, dir.name, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return undefined;
};

// Seeds a transcript straight into the projects dir the server reads from.
// `content` may be a plain string or a claude content-block array.
const insertMessages = (
  projectsRoot: string,
  sessionId: string,
  messages: MessageSeed[],
): void => {
  let path = findSessionFile(projectsRoot, sessionId);
  if (path === undefined) {
    const dir = join(projectsRoot, encodeWorkingDir("/seeded"));
    mkdirSync(dir, { recursive: true });
    path = join(dir, `${sessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "ai-title",
        aiTitle: "seed session",
        sessionId,
        cwd: "/seeded",
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  }
  let ts = Date.now();
  const parts: string[] = [];
  for (const m of messages) {
    const t = m.createdTimestamp ?? ts;
    parts.push(
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: m.role === "user" ? "user" : "assistant",
        message: { role: m.role, content: m.content },
        uuid: m.messageId ?? randomUUID(),
        timestamp: new Date(t).toISOString(),
        sessionId,
      }),
    );
    ts += 1000;
  }
  appendFileSync(path, `${parts.join("\n")}\n`);
  utimesSync(path, new Date(), new Date(ts));
};

const serveArgs = (dbs: Databases, port: number): string[] => [
  "serve",
  "-p",
  String(port),
  "--projects-dir",
  dbs.projectsDir,
  "--meta-db",
  dbs.metaDb,
  "--auth-db",
  dbs.authDb,
  "--prompts-db",
  dbs.promptsDb,
  "--groups-db",
  dbs.groupsDb,
  "--claude-binary",
  "claude",
];

const stopProcess = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGTERM");
  });

// mockBin prepends a temp dir to PATH so glv finds the mocked binary.
const mockScript = (bin: string, file: string): Promise<() => void> =>
  mockBin(bin, `node --import ${tsxLoader}`, { file });

const mockClaude = (): Promise<() => void> =>
  mockScript("claude", claudeMockScriptPath);

// Lets pr-state/git-info tests exercise `gh pr view` without a token or network.
const mockGh = (): Promise<() => void> => mockScript("gh", ghMockScriptPath);

const startServer = (
  dbs: Databases,
  port: number,
  extraEnv: Record<string, string> = {},
): { proc: ChildProcess; readStderr: () => string } => {
  let stderr = "";
  const proc = spawn(GLV, serveArgs(dbs, port), {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { proc, readStderr: () => stderr };
};

const mockEnv = (mock: MockConfig): Record<string, string> => ({
  CLAUDE_MOCK_SESSION_NAME: mock.sessionName ?? "",
  CLAUDE_MOCK_SLEEP_MS: String(mock.sleepMs ?? 0),
  CLAUDE_MOCK_EXIT_CODE: String(mock.exitCode ?? 0),
  CLAUDE_MOCK_LINES: (mock.lines ?? []).join("\n"),
  CLAUDE_MOCK_LINE_DELAY_MS: String(mock.lineDelayMs ?? 0),
  CLAUDE_MOCK_WRITE_DB: mock.writeDb === true ? "1" : "",
  CLAUDE_MOCK_CAPTURE_STDIN: mock.captureStdin ?? "",
  CLAUDE_MOCK_CAPTURE_CWD: mock.captureCwd ?? "",
  CLAUDE_MOCK_CAPTURE_ARGS: mock.captureArgs ?? "",
  CLAUDE_MOCK_SPAWN_CHILD: mock.spawnChild ?? "",
});

const startIntegrationEnv = async (
  prefix: string,
  mock: MockConfig = {},
  homeDir?: string,
): Promise<IntegrationEnv> => {
  const scratchDir = mkdtempSync(join(tmpdir(), prefix));
  const dbs = createDatabases(scratchDir);
  const uploadsDir = join(scratchDir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const tempDir = join(scratchDir, "tmp");
  mkdirSync(tempDir, { recursive: true });
  const restoreClaudePath = await mockClaude();
  const restoreGhPath = await mockGh();

  const port = await findFreePort();
  const baseUrl = `http://localhost:${port}`;
  const { proc, readStderr } = startServer(dbs, port, {
    CLAUDE_MOCK_PROJECTS_DIR: dbs.projectsDir,
    GLV_UPLOADS_DIR: uploadsDir,
    GLV_TEMP_DIR: tempDir,
    ...(homeDir !== undefined ? { HOME: homeDir } : {}),
    ...mockEnv(mock),
  });

  await waitForHttp(baseUrl);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "glv_session",
      value: dbs.token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  const cleanup = async (): Promise<void> => {
    await context.close();
    await browser.close();
    await stopProcess(proc);
    restoreClaudePath();
    restoreGhPath();
    const stderr = readStderr();
    if (stderr.trim() !== "") console.error("glv serve stderr:\n" + stderr);
    rmSync(scratchDir, { recursive: true, force: true });
  };

  return {
    scratchDir,
    baseUrl,
    cookie: `glv_session=${dbs.token}`,
    context,
    dbs,
    uploadsDir,
    tempDir,
    serverStderr: readStderr,
    cleanup,
  };
};

const withPage = async (
  context: BrowserContext,
  run: (page: Page) => Promise<void>,
): Promise<void> => {
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await page.close();
  }
};

const authedFetch = (
  env: IntegrationEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const headers: Record<string, string> = { cookie: env.cookie };
  const extra = init.headers as Record<string, string> | undefined;
  if (extra !== undefined) Object.assign(headers, extra);
  return fetch(`${env.baseUrl}${path}`, {
    ...init,
    headers,
    redirect: "manual",
  });
};

type SseEvent = { event: string; data: string; id: string | undefined };

const parseSseData = (data: string): Record<string, unknown> =>
  tryParseJson<Record<string, unknown>>(data) ?? {};

// Parses one SSE line: field lines update `current` in place; an empty line
// (frame boundary) returns the accumulated event if one is in progress.
const parseSseLine = (
  line: string,
  current: Partial<SseEvent>,
): SseEvent | undefined => {
  if (line === "") {
    if (current.event === undefined) return undefined;
    return {
      event: current.event,
      data: current.data ?? "",
      id: current.id,
    };
  }
  if (line.startsWith("event:")) current.event = line.slice(6).trim();
  else if (line.startsWith("data:"))
    current.data = (current.data ?? "") + line.slice(5).trim();
  else if (line.startsWith("id:")) current.id = line.slice(3).trim();
  return undefined;
};

const readSseStream = async (
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
  until: (events: SseEvent[]) => boolean,
  events: SseEvent[],
  onEvent?: (event: SseEvent) => void,
): Promise<void> => {
  const decoder = new TextDecoder();
  let buf = "";
  let current: Partial<SseEvent> = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      const event = parseSseLine(line, current);
      if (line === "") {
        current = {};
        if (event !== undefined) {
          events.push(event);
          onEvent?.(event);
        }
        if (until(events)) return;
      }
    }
  }
};

// Reads an SSE endpoint until `until` is satisfied or `timeoutMs` elapses.
// The server keeps streams open indefinitely, so the reader is always released.
const collectSse = async (
  env: IntegrationEnv,
  path: string,
  until: (events: SseEvent[]) => boolean,
  timeoutMs = 10000,
  onEvent?: (event: SseEvent) => void,
): Promise<SseEvent[]> =>
  new Promise((resolve, reject) => {
    const events: SseEvent[] = [];
    let reader:
      | ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>
      | undefined;

    const timer = setTimeout(() => {
      reader?.cancel().catch(() => undefined);
      reject(
        new Error(
          `timed out after ${timeoutMs}ms; got ${events.length} events`,
        ),
      );
    }, timeoutMs);

    const finish = (): void => {
      clearTimeout(timer);
      reader?.cancel().catch(() => undefined);
      resolve(events);
    };

    void authedFetch(env, path, { headers: { accept: "text/event-stream" } })
      .then(async (res) => {
        if (res.body === null) throw new Error("no response body");
        reader = res.body.getReader();
        await readSseStream(reader, until, events, onEvent);
        finish();
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });

export type { IntegrationEnv, SseEvent };
export {
  authedFetch,
  collectSse,
  findFreePort,
  GLV,
  insertMessages,
  insertSessions,
  mockClaude,
  parseSseData,
  ROOT,
  startIntegrationEnv,
  stopProcess,
  waitForHttp,
  withPage,
};
