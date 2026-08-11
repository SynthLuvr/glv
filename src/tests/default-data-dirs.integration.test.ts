import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { mockBin } from "type-a-bin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GLV = join(ROOT, "bin", "glv");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const gooseMockScriptPath = fileURLToPath(
  new URL("./goose-mock-script.ts", import.meta.url),
);

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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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

// Boots `glv serve` with a fake HOME and NO --auth-db / --prompts-db /
// --groups-db overrides so the glv-owned databases resolve to the platform
// default.  Verifies the server actually creates them there.
describe("platform-aware default data directory", () => {
  let homeDir: string;
  let restoreGoose: (() => void) | undefined;

  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "glv-default-data-"));
  });

  afterAll(async () => {
    restoreGoose?.();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("creates glv-owned databases under the default data directory", async () => {
    restoreGoose = await mockBin("goose", `node --import ${tsxLoader}`, {
      file: gooseMockScriptPath,
    });

    const sessionsDb = join(homeDir, "sessions.db");
    const sdb = new DatabaseSync(sessionsDb);
    sdb.exec(SESSIONS_SCHEMA);
    sdb.close();

    const port = await findFreePort();
    const baseUrl = `http://localhost:${port}`;
    const proc = spawn(
      GLV,
      [
        "serve",
        "--db",
        sessionsDb,
        "-p",
        String(port),
        "--goose-binary",
        "goose",
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: homeDir },
      },
    );
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      await waitForHttp(baseUrl);

      // On Unix the default is ~/.local/share/glv; the fake HOME redirects
      // it to our temp dir so we can assert without polluting the real home.
      const dataDir = join(homeDir, ".local", "share", "glv");
      expect(existsSync(join(dataDir, "auth.db"))).toBe(true);
      expect(existsSync(join(dataDir, "prompts.db"))).toBe(true);
      expect(existsSync(join(dataDir, "groups.db"))).toBe(true);
    } finally {
      await stopProcess(proc);
      if (stderr.trim() !== "") console.error("glv serve stderr:\n" + stderr);
    }
  }, 30000);
});

// Runs `glv config set` with a fake HOME and no GLV_CONFIG override so the
// config file resolves to the platform default.
describe("platform-aware default config directory", () => {
  let homeDir: string;

  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "glv-default-config-"));
  });

  afterAll(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes the config file under the default config directory", () => {
    const result = spawnSync(
      GLV,
      ["config", "set", "forwardHost", "example.com"],
      { env: { ...process.env, HOME: homeDir }, encoding: "utf-8" },
    );
    expect(result.status).toBe(0);

    const configPath = join(homeDir, ".config", "glv", "config.json");
    expect(existsSync(configPath)).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(raw.forwardHost).toBe("example.com");
  });
});
