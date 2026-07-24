import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

// glv reads the goose sessions database to populate the sidebar, so the table
// must exist up front. The columns mirror goose's real schema.
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GLV = join(ROOT, "bin", "glv");

// The mock goose is never invoked by these tests (no sessions are started
// through the UI), but `glv serve` requires a resolvable goose binary on
// PATH. mockBin runs it through tsx against this script.
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

type SessionSeed = { id: string; name: string; workingDir: string };

type Databases = {
  sessionsDb: string;
  authDb: string;
  promptsDb: string;
  groupsDb: string;
  token: string;
};

const createDatabases = (scratchDir: string): Databases => {
  const sessionsDb = join(scratchDir, "sessions.db");
  const sdb = new DatabaseSync(sessionsDb);
  // WAL lets the test process insert rows while the server reads, without
  // SQLITE_BUSY. The sessions table starts empty so the sidebar's empty
  // state is exercised first.
  sdb.exec("PRAGMA journal_mode=WAL");
  sdb.exec(SESSIONS_SCHEMA);
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
    token,
  };
};

// Inserts sessions straight into the sessions database. The server reads
// fresh on every request, so the sidebar reflects them on the next page load
// without a restart.
const insertSessions = (dbPath: string, sessions: SessionSeed[]): void => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const stmt = db.prepare(
    "INSERT INTO sessions (id, name, session_type, working_dir, created_at, updated_at) " +
      "VALUES (?, ?, 'user', ?, datetime('now'), datetime('now'))",
  );
  for (const s of sessions) stmt.run(s.id, s.name, s.workingDir);
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
  scratchDir = mkdtempSync(join(tmpdir(), "glv-sidebar-"));
  dbs = createDatabases(scratchDir);

  // mockBin prepends its temp dir to PATH, which the glv subprocess inherits,
  // so resolveGooseBinary finds `goose` even though it is never invoked.
  restoreGoosePath = await mockBin("goose", `node --import ${tsxLoader}`, {
    file: gooseMockScriptPath,
  });

  const port = await findFreePort();
  baseUrl = `http://localhost:${port}`;

  serve = spawn(GLV, serveArgs(dbs, port), {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
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

describe("sidebar — session list visibility", () => {
  it("shows an empty state when the database has no sessions", async () => {
    await withPage(async (page) => {
      await page.goto(baseUrl);

      // The empty-state message replaces the session list.
      await expect(page.locator(".sidebar .empty")).toBeVisible();
      await expect(page.locator(".empty")).toContainText("No sessions found");

      // No session-list container or items are rendered.
      await expect(page.locator("#session-list")).toHaveCount(0);
      await expect(page.locator(".session-item")).toHaveCount(0);

      // The header counter reflects the empty database.
      await expect(page.locator(".session-count")).toHaveText("0");
    });
  });

  it("shows sessions in the sidebar once they exist in the database", async () => {
    const seeds: SessionSeed[] = [
      {
        id: "sidebar-alpha",
        name: "Alpha Session",
        workingDir: join(scratchDir, "alpha"),
      },
      {
        id: "sidebar-beta",
        name: "Beta Session",
        workingDir: join(scratchDir, "beta"),
      },
    ];
    insertSessions(dbs.sessionsDb, seeds);

    await withPage(async (page) => {
      await page.goto(baseUrl);

      // The session-list container is now rendered.
      await expect(page.locator("#session-list")).toBeVisible();

      // The empty-state message is gone.
      await expect(page.locator(".sidebar .empty")).toHaveCount(0);

      // Each session appears as a sidebar item with its name.
      await expect(page.locator(".session-item")).toHaveCount(2);
      await expect(page.locator("#session-list")).toContainText(
        "Alpha Session",
      );
      await expect(page.locator("#session-list")).toContainText("Beta Session");

      // The header counter reflects the populated database.
      await expect(page.locator(".session-count")).toHaveText("2");
    });
  });
});
