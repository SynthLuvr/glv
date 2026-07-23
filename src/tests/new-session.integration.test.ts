import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
} from "@playwright/test";
import { mockBin } from "type-a-bin";
import { afterAll, beforeAll, describe, it } from "vitest";

// glv only reads the goose sessions database (and writes during serve), so
// both tables must exist up front: the initial sidebar query needs them, and
// the mock goose must INSERT the session row it is expected to create.
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

const SESSION_NAME = "Integration Test Session";
const PROMPT_TEXT = "Build the project and report the result.";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GLV = join(ROOT, "bin", "glv");

// The mock runs through tsx against this script. Keeping it as a real .ts file
// means tsx transforms it (the mock binary itself is an extensionless temp
// file, which tsx cannot parse). glv spawns the mock goose from the temp
// workDir — which has no node_modules — so tsx is resolved to an absolute
// loader path here (the type-a-bin example uses the bare `node --import tsx`
// because its binary runs from the repo root). The DB path and session name
// are passed through the environment.
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const gooseMockScriptPath = fileURLToPath(
  new URL("./goose-mock-script.ts", import.meta.url),
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

type Databases = {
  sessionsDb: string;
  authDb: string;
  promptsDb: string;
  groupsDb: string;
  workDir: string;
  token: string;
};

const createDatabases = (scratchDir: string): Databases => {
  const workDir = join(scratchDir, "project");
  mkdirSync(workDir, { recursive: true });

  const sessionsDb = join(scratchDir, "sessions.db");
  const sdb = new DatabaseSync(sessionsDb);
  // WAL lets the server read while the mock goose writes, without SQLITE_BUSY.
  sdb.exec("PRAGMA journal_mode=WAL");
  sdb.exec(SESSIONS_SCHEMA);
  // The sidebar's #session-list container is only rendered for a non-empty
  // list; the empty state omits it, leaving the out-of-band swap with no
  // target. Seed a session in a different working dir so it never collides
  // with new-session detection.
  sdb
    .prepare(
      "INSERT INTO sessions (id, name, session_type, working_dir, updated_at) " +
        "VALUES (?, ?, 'user', ?, datetime('now'))",
    )
    .run("seed-session", "Seed Project", join(scratchDir, "other-project"));
  sdb.close();

  // Satisfy the WebAuthn gate without a real passkey: the token below becomes
  // the glv_session cookie the browser presents.
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
    workDir,
    token,
  };
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

// SIGTERM, then escalate to SIGKILL after 5 s.
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

let scratchDir: string;
let restoreGoosePath: () => void;
let serve: ChildProcess;
let serveStderr = "";
let browser: Browser;
let context: BrowserContext;
let baseUrl: string;
let dbs: Databases;

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "glv-integration-"));
  dbs = createDatabases(scratchDir);

  // mockBin prepends its temp dir to PATH, which the glv subprocess inherits,
  // so resolveGooseBinary finds `goose` and spawns our mock.
  restoreGoosePath = await mockBin("goose", `node --import ${tsxLoader}`, {
    file: gooseMockScriptPath,
  });

  const port = await findFreePort();
  baseUrl = `http://localhost:${port}`;

  serve = spawn(GLV, serveArgs(dbs, port), {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GOOSE_SESSIONS_DB: dbs.sessionsDb,
      GOOSE_MOCK_SESSION_NAME: SESSION_NAME,
    },
  });
  serve.stderr?.on("data", (chunk: Buffer) => {
    serveStderr += chunk.toString();
  });

  await waitForHttp(baseUrl);

  browser = await chromium.launch();
  context = await browser.newContext();
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
}, 90000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  if (serve !== undefined) await stopProcess(serve);
  restoreGoosePath?.();
  if (serveStderr.trim() !== "")
    console.error("glv serve stderr:\n" + serveStderr);
  if (scratchDir !== undefined)
    rmSync(scratchDir, { recursive: true, force: true });
});

const withPage = async (run: (page: Page) => Promise<void>): Promise<void> => {
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await page.close();
  }
};

describe("new session — working directory flow", () => {
  it("loads the New Session page for an authenticated user", async () => {
    await withPage(async (page) => {
      await page.goto(baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();
      await expect(page.locator('textarea[name="prompt"]')).toBeVisible();
      await expect(page.locator("button.send-btn")).toHaveText("Start session");
    });
  });

  it("starts a goose session from the form", async () => {
    await withPage(async (page) => {
      await page.goto(baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();

      await page.locator('input[name="working_dir"]').fill(dbs.workDir);
      await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
      await page.locator("button.send-btn").click();

      // The transcript replaces the form once goose creates the session and
      // glv re-keys the run onto the real session id.
      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });

      await expect(page.locator("#detail-pane")).toContainText(PROMPT_TEXT);

      // The sidebar refreshes out-of-band, so the new session appears without
      // a full page reload.
      await expect(page.locator("#session-list")).toContainText(SESSION_NAME, {
        timeout: 5000,
      });

      await expect(page.locator(".status-hint.error")).toHaveCount(0);
    });
  });
});
