import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";

// goose owns this schema in production; glv only reads it. Both tables must
// exist before startup so the sidebar query does not throw and the mock goose
// can INSERT the new session row.
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

// Stand-in for the real goose binary. glv spawns `goose run`, then polls the
// sessions DB for a new row in the working directory. This mock inserts that
// row and emits one NDJSON reply line before exiting 0.
const GOOSE_MOCK_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const dbPath = process.env.GOOSE_SESSIONS_DB;
if (dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const id = "mock-" + process.pid + "-" + Date.now();
  const sql =
    "INSERT INTO sessions (id, name, session_type, working_dir, created_at, updated_at) " +
    "VALUES (?, ?, 'user', ?, datetime('now'), datetime('now'))";
  db.prepare(sql).run(id, ${JSON.stringify(SESSION_NAME)}, process.cwd());
  db.close();
}
console.log(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "mock goose reply" }] }));
`;

// mock-a-bin is Deno-native, so this runs under deno. It registers the goose
// mock as an executable and prints the PATH directory it was installed in.
const DENO_MOCK_HELPER = `
import { mockBin } from "jsr:@levibostian/mock-a-bin";
const code = await Deno.readTextFile(Deno.args[0]);
await mockBin("goose", "node", code);
const dir = (Deno.env.get("PATH") ?? "").split(":")[0];
console.log(dir);
`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GLV = join(ROOT, "bin", "glv");

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
      const port = addr.port;
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

const killProcess = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGTERM");
  });

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

  // WAL mode lets the server poll (read) while the mock goose writes a new
  // session row without a SQLITE_BUSY collision.
  const sessionsDb = join(scratchDir, "sessions.db");
  const sdb = new DatabaseSync(sessionsDb);
  sdb.exec("PRAGMA journal_mode=WAL");
  sdb.exec(SESSIONS_SCHEMA);
  // Seed a session so the sidebar renders #session-list (the empty state
  // omits it). Its working dir differs from the test project so it never
  // collides with new-session detection.
  sdb
    .prepare(
      "INSERT INTO sessions (id, name, session_type, working_dir, updated_at) " +
        "VALUES (?, ?, 'user', ?, datetime('now'))",
    )
    .run("seed-session", "Seed Project", join(scratchDir, "other-project"));
  sdb.close();

  // Pre-seed a valid session to bypass the WebAuthn gate without a real
  // passkey flow. The token becomes the browser's glv_session cookie.
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

const prepareGooseMock = (scratchDir: string): string => {
  const gooseScript = join(scratchDir, "goose-mock.cjs");
  writeFileSync(gooseScript, GOOSE_MOCK_SCRIPT);
  const helper = join(scratchDir, "deno-mock-helper.ts");
  writeFileSync(helper, DENO_MOCK_HELPER);
  const res = spawnSync("deno", ["run", "--allow-all", helper, gooseScript], {
    encoding: "utf-8",
  });
  if (res.error !== undefined || res.status !== 0)
    throw new Error(
      `deno mock helper failed: ${res.error?.message ?? res.stderr}`,
    );
  return res.stdout.trim();
};

let scratchDir: string;
let mockBinDir: string;
let serve: ChildProcess;
let serveStderr = "";
let browser: Browser;
let context: BrowserContext;
let baseUrl: string;
let dbs: Databases;

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "glv-integration-"));

  dbs = createDatabases(scratchDir);
  mockBinDir = prepareGooseMock(scratchDir);

  const port = await findFreePort();
  baseUrl = `http://localhost:${port}`;

  serve = spawn(
    GLV,
    [
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
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${mockBinDir}:${process.env.PATH ?? ""}`,
        GOOSE_SESSIONS_DB: dbs.sessionsDb,
      },
    },
  );
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
  if (serve !== undefined && serve.exitCode === null) await killProcess(serve);
  if (serveStderr.trim() !== "")
    console.error("glv serve stderr:\n" + serveStderr);
  if (scratchDir !== undefined)
    rmSync(scratchDir, { recursive: true, force: true });
  if (mockBinDir !== undefined)
    rmSync(mockBinDir, { recursive: true, force: true });
});

describe("new session — working directory flow", () => {
  it("loads the New Session page for an authenticated user", async () => {
    const page = await context.newPage();
    try {
      await page.goto(baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();
      await expect(page.locator('textarea[name="prompt"]')).toBeVisible();
      await expect(page.locator("button.send-btn")).toHaveText("Start session");
    } finally {
      await page.close();
    }
  });

  it("starts a goose session from the form", async () => {
    const page = await context.newPage();
    try {
      await page.goto(baseUrl);
      await expect(page.locator("form.new-session-form")).toBeVisible();

      await page.locator('input[name="working_dir"]').fill(dbs.workDir);
      await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
      await page.locator("button.send-btn").click();

      // The transcript replaces the form once goose creates the session.
      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });

      await expect(page.locator("#detail-pane")).toContainText(PROMPT_TEXT);

      // The out-of-band sidebar refresh lists the new session.
      await expect(page.locator("#session-list")).toContainText(SESSION_NAME, {
        timeout: 5000,
      });

      await expect(page.locator(".status-hint.error")).toHaveCount(0);
    } finally {
      await page.close();
    }
  });
});
