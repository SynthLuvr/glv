import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "@playwright/test";
import { mockBin } from "type-a-bin";

// Both tables must exist before the server starts: the sidebar queries them
// and the mock goose inserts into them.
const SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_tokens INTEGER,
  provider_name TEXT,
  user_set_name BOOLEAN DEFAULT FALSE,
  archived_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tokens INTEGER,
  metadata_json TEXT
);
`;

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

const INSERT_SESSION_SQL =
  "INSERT INTO sessions (id, name, session_type, working_dir, created_at, updated_at) " +
  "VALUES (?, ?, 'user', ?, datetime('now'), datetime('now'))";

const INSERT_MESSAGE_SQL =
  "INSERT INTO messages (message_id, session_id, role, content_json, " +
  "created_timestamp, timestamp) VALUES (?, ?, ?, ?, ?, datetime('now'))";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GLV = join(ROOT, "bin", "glv");

// tsx is resolved to an absolute loader path because the mock goose runs from
// a temp dir with no node_modules.
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const gooseMockScriptPath = fileURLToPath(
  new URL("./goose-mock-script.ts", import.meta.url),
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

// A content_json string or an array of content items, written verbatim into the
// message row so transcript-rendering tests can seed rich transcripts.
type MessageSeed = {
  role: string;
  content: unknown;
  createdTimestamp?: number;
  messageId?: string;
};

type Databases = {
  sessionsDb: string;
  authDb: string;
  promptsDb: string;
  groupsDb: string;
  token: string;
};

type MockConfig = {
  /** Delay (ms) before the mock emits output, keeping a run "running". */
  sleepMs?: number;
  /** goose exit code; non-zero surfaces as a runner error. */
  exitCode?: number;
  /** NDJSON lines to emit (newline-joined); default is a single reply. */
  lines?: string[];
  /** Name written into a new session row. */
  sessionName?: string;
};

type IntegrationEnv = {
  scratchDir: string;
  baseUrl: string;
  cookie: string;
  context: BrowserContext;
  dbs: Databases;
  cleanup: () => Promise<void>;
};

// WAL lets a test process (or the mock goose) write while the server reads,
// without SQLITE_BUSY. The auth row satisfies the WebAuthn gate without a
// real passkey: the returned token becomes the glv_session cookie.
const createDatabases = (scratchDir: string): Databases => {
  const sessionsDb = join(scratchDir, "sessions.db");
  const sdb = new DatabaseSync(sessionsDb);
  sdb.exec("PRAGMA journal_mode=WAL");
  sdb.exec(SESSIONS_SCHEMA);
  sdb.close();

  const authDb = join(scratchDir, "auth.db");
  const adb = new DatabaseSync(authDb);
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

  return {
    sessionsDb,
    authDb,
    promptsDb: join(scratchDir, "prompts.db"),
    groupsDb: join(scratchDir, "groups.db"),
    token,
  };
};

// The server reads fresh on every request, so sessions inserted here appear in
// the sidebar on the next page load without a restart.
const insertSessions = (dbPath: string, sessions: SessionSeed[]): void => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const stmt = db.prepare(INSERT_SESSION_SQL);
  for (const s of sessions) stmt.run(s.id, s.name, s.workingDir);
  db.close();
};

// Seeds a transcript straight into the goose sessions DB the server reads
// from. `content` may be a raw JSON string or an array of content items.
const insertMessages = (
  dbPath: string,
  sessionId: string,
  messages: MessageSeed[],
): void => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const stmt = db.prepare(INSERT_MESSAGE_SQL);
  let ts = Date.now();
  for (const m of messages) {
    const contentJson =
      typeof m.content === "string"
        ? (m.content as string)
        : JSON.stringify(m.content);
    stmt.run(
      m.messageId ?? null,
      sessionId,
      m.role,
      contentJson,
      m.createdTimestamp ?? ts,
    );
    ts += 1000;
  }
  db.close();
};

const serveArgs = (dbs: Databases, port: number): string[] => [
  "serve",
  "-p",
  String(port),
  "--db",
  dbs.sessionsDb,
  "--auth-db",
  dbs.authDb,
  "--prompts-db",
  dbs.promptsDb,
  "--groups-db",
  dbs.groupsDb,
  "--goose-binary",
  "goose",
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

// mockBin prepends its temp dir to PATH so the glv subprocess finds `goose`.
const mockGoose = (): Promise<() => void> =>
  mockBin("goose", `node --import ${tsxLoader}`, {
    file: gooseMockScriptPath,
  });

// Mocked `gh` lets pr-state/git-info tests exercise the real `gh pr view`
// flow without a GitHub token or network.
const mockGh = (): Promise<() => void> =>
  mockBin("gh", `node --import ${tsxLoader}`, { file: ghMockScriptPath });

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
  GOOSE_MOCK_SESSION_NAME: mock.sessionName ?? "",
  GOOSE_MOCK_SLEEP_MS: String(mock.sleepMs ?? 0),
  GOOSE_MOCK_EXIT_CODE: String(mock.exitCode ?? 0),
  GOOSE_MOCK_LINES: (mock.lines ?? []).join("\n"),
});

const startIntegrationEnv = async (
  prefix: string,
  mock: MockConfig = {},
): Promise<IntegrationEnv> => {
  const scratchDir = mkdtempSync(join(tmpdir(), prefix));
  const dbs = createDatabases(scratchDir);
  const restoreGoosePath = await mockGoose();
  const restoreGhPath = await mockGh();

  const port = await findFreePort();
  const baseUrl = `http://localhost:${port}`;
  const { proc, readStderr } = startServer(dbs, port, {
    GOOSE_SESSIONS_DB: dbs.sessionsDb,
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
    restoreGoosePath();
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

const parseSseData = (data: string): Record<string, unknown> => {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
};

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
        if (event !== undefined) events.push(event);
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
        await readSseStream(reader, until, events);
        finish();
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });

export type { IntegrationEnv, MessageSeed, MockConfig, SessionSeed, SseEvent };
export {
  authedFetch,
  collectSse,
  insertMessages,
  insertSessions,
  parseSseData,
  startIntegrationEnv,
  withPage,
};
