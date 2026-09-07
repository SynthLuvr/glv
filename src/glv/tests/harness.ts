import {
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawn,
  spawnSync,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
} from "@playwright/test";
import {
  type MockBinBehaviour,
  type MockBinCall,
  type MockBinHandle,
  mockBin,
  rmScratch,
} from "type-a-bin";
import {
  ROOTS_ENV,
  rawCoverageDir,
  stripCoverageHookFromNodeOptions,
} from "type-a-bin/subprocess-coverage";
import { sessionCookieName } from "../auth/service.js";
import { AnyJson, JsonObject, parseJson } from "../parse.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Both flavors gate the viewer behind the same WebAuthn scheme; the harness
// satisfies it without a real passkey by seeding a session row whose token
// becomes the cookie.
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

const seedAuthDb = (dbPath: string): string => {
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
  return token;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Counts sub-directories of a data root (uploads, temp) to observe
// directories being created and swept.
const subdirCount = (base: string): number =>
  readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())
    .length;

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

// A capture file written by a mock agent can be read mid-write, so poll
// until it parses into a value the caller recognises. The 30s default
// absorbs slow mock-agent spawns on loaded CI runners.
const waitForJsonFile = async <T>(
  path: string,
  accept: (value: unknown) => value is T,
  timeoutMs = 30000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const parsed = parseJson(readFileSync(path, "utf-8"), AnyJson);
      if (parsed.ok && accept(parsed.data)) return parsed.data;
    }
    await sleep(50);
  }
  throw new Error(`json file ${path} not written within ${timeoutMs}ms`);
};

// Shared argv-inspection helpers for suites that assert on the flags a
// mock agent received (see the captureArgs mock option).
const isArgv = (value: unknown): value is string[] => Array.isArray(value);

const waitForArgs = (path: string): Promise<string[]> =>
  waitForJsonFile(path, isArgv);

// Waits for a capture file to settle before assertions see it: reads are
// retried through transient failures (file not created yet, Windows
// locking a fresh rename), and only content identical on two consecutive
// polls is returned — a mid-write read must never leak into an expect.
const waitForFile = async (
  path: string,
  timeoutMs = 30000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let previous: string | undefined;
  while (Date.now() < deadline) {
    try {
      const content = readFileSync(path, "utf-8");
      if (content === previous) return content;
      previous = content;
    } catch {
      // the writer may not have started yet — keep polling
    }
    await sleep(50);
  }
  const lastRead =
    previous === undefined
      ? "never readable"
      : `last read ${previous.length} bytes`;
  throw new Error(
    `file ${path} not written within ${timeoutMs}ms (${lastRead})`,
  );
};

const flagValue = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const waitForHttp = async (url: string, timeoutMs = 60000): Promise<void> => {
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

type SessionSeed = {
  id: string;
  name: string;
  workingDir: string;
  /** The provider recorded on the session row (goose's store). */
  providerName?: string;
  /** The model the session ran with; flavors map it into their own store. */
  model?: string;
};

// A content payload (plain string or content-block array), written verbatim
// into the flavor's store so transcript-rendering tests can seed rich data.
type MessageSeed = {
  role: string;
  content: unknown;
  createdTimestamp?: number;
  messageId?: string;
  /** The model that produced an assistant turn (claude's transcript). */
  model?: string;
};

type MockConfig = {
  /** Delay (ms) before the mock emits output, keeping a run "running". */
  sleepMs?: number;
  /** Agent exit code; non-zero surfaces as a runner error. */
  exitCode?: number;
  /** NDJSON lines to emit (newline-joined); default is a single reply. */
  lines?: string[];
  /** Name written into a new session (ai-title row/line). */
  sessionName?: string;
  /** Pause (ms) between streamed lines so a tail fills incrementally. */
  lineDelayMs?: number;
  /** When set, persist each line to the agent-owned store as produced. */
  writeDb?: boolean;
  /** When set, writes the agent's stdin (the full prompt) to this path. */
  captureStdin?: string;
  /** When set, writes the agent's working directory to this path. */
  captureCwd?: string;
  /** When set, writes the agent's argv (JSON string[]) to this path. */
  captureArgs?: string;
  /** When set, writes the agent's extra env (JSON) to this path. */
  captureEnv?: string;
  /**
   * JSON value the mock agent reports for its ACP provider inventory
   * (`{ entries: [...] }`); unset means "agent can't list providers" so the
   * model picker degrades to config-only choices. Goose mock only.
   */
  acpProviders?: string;
  /**
   * JSON map provider id → model ids the mock agent reports for ACP
   * providers with no static catalogue models. Goose mock only.
   */
  acpSupportedModels?: string;
  /**
   * Delay (ms) before the mock's ACP conversation starts answering,
   * simulating a slow agent-binary catalogue enumeration. Goose mock only.
   */
  acpDelayMs?: number;
  /** When set, the agent never creates the session's data (row/transcript). */
  neverCreateSession?: boolean;
  /**
   * Replaces the mock agent script with a scripted type-a-bin behaviour,
   * for suites that need the agent as a process (silent, long-lived,
   * signal-trapping, spawning a descendant) rather than as a store writer.
   * The invocations land on `env.agentMock`.
   */
  behaviour?: MockBinBehaviour;
};

type Databases = {
  readonly authDb: string;
  readonly promptsDb: string;
  readonly groupsDb: string;
  readonly token: string;
  /**
   * Flavor-specific store paths (goose: sessionsDb; claude: projectsDir,
   * metaDb).
   */
  readonly flavor: Record<string, string>;
};

type IntegrationEnv = {
  scratchDir: string;
  baseUrl: string;
  cookie: string;
  /** Session cookie name this server reads (derived from its auth DB). */
  cookieName: string;
  /**
   * PID of the spawned launcher process — the launcher loads the CLI
   * in-process, so this is also the serve process's PID.
   */
  serverPid: number | undefined;
  context: BrowserContext;
  dbs: Databases;
  /** GLV's private uploads directory (temp dir, cleaned up on test end). */
  uploadsDir: string;
  /** GLV's private temp working-directory area (cleaned up on test end). */
  tempDir: string;
  /** Reads stderr accumulated by the glv serve process (e.g. console.warn). */
  serverStderr: () => string;
  /** Recorded agent invocations, when the config scripted a behaviour. */
  agentMock: MockBinHandle | undefined;
  cleanup: () => Promise<void>;
};

// The glv-owned databases every flavor creates under its scratch dir
// (auth/prompts/groups), paired with the flavor's own store paths.
const baseDatabases = (
  scratchDir: string,
  flavor: Record<string, string>,
): Databases => {
  const authDb = join(scratchDir, "auth.db");
  return {
    authDb,
    promptsDb: join(scratchDir, "prompts.db"),
    groupsDb: join(scratchDir, "groups.db"),
    token: seedAuthDb(authDb),
    flavor,
  };
};

// The serve flags every flavor passes for its glv-owned databases.
const dbOverrideArgs = (dbs: Databases): string[] => [
  "--auth-db",
  dbs.authDb,
  "--prompts-db",
  dbs.promptsDb,
  "--groups-db",
  dbs.groupsDb,
];

type SseEvent = { event: string; data: string; id: string | undefined };

// What each flavor provides to the generic boot machinery.
type FlavorAdapter = {
  readonly name: string;
  /** Absolute path to the flavor's Node launcher (bin/glv-*.mjs). */
  readonly binPath: string;
  readonly mockBinName: string;
  readonly mockScriptPath: string;
  readonly mockEnvPrefix: string;
  /** Creates the flavor's stores under the scratch dir (auth included). */
  readonly createDatabases: (scratchDir: string) => Databases;
  /** `serve` argv beyond `serve -p <port>` (store + db overrides). */
  readonly serveArgs: (dbs: Databases) => string[];
  /** Server env wiring the flavor's store override + mock live-write root. */
  readonly serverEnv: (dbs: Databases) => Record<string, string>;
};

// What a shared suite receives: every flavor difference behind one object,
// so suite bodies contain no flavor branches.
type FlavorFixture = {
  readonly name: string;
  /** Capitalized agent name for copy assertions ("Goose", "Claude"). */
  readonly displayName: string;
  readonly binName: string;
  /** Snippet of the mock agent's default reply text. */
  readonly mockReply: string;
  readonly startEnv: (
    prefix: string,
    mock?: MockConfig,
    homeDir?: string,
    extraEnv?: Record<string, string>,
  ) => Promise<IntegrationEnv>;
  readonly seedSessions: (env: IntegrationEnv, seeds: SessionSeed[]) => void;
  readonly seedMessages: (
    env: IntegrationEnv,
    sessionId: string,
    messages: MessageSeed[],
  ) => void;
  /** Backdates a session's update timestamp (epoch ms) in the flavor's store. */
  readonly backdateSession: (
    env: IntegrationEnv,
    sessionId: string,
    epochMs: number,
  ) => void;
  /** A tool-call content block in the flavor's native format. */
  readonly toolRequest: (
    name: string,
    args: Record<string, unknown>,
  ) => unknown;
  /** A tool-result content block in the flavor's native format. */
  readonly toolResponse: (text: string, isError: boolean) => unknown;
  /** One NDJSON preview line in the flavor's stream dialect. */
  readonly streamLine: (text: string) => string;
  /** One NDJSON line in the foreign envelope — the viewer must drop it. */
  readonly foreignLine: string;
  /** Non-JSON banner text the flavor's agent may emit. */
  readonly rawBanner: string;
  /**
   * Reads a session metadata column ("name", "user_set_name") from the
   * flavor's store — goose: the sessions table; claude: the meta sidecar.
   */
  readonly readSessionField: (
    env: IntegrationEnv,
    field: string,
    id: string,
  ) => unknown;
  /** Renames a session the way the flavor's agent does mid-run. */
  readonly renameSession: (
    env: IntegrationEnv,
    id: string,
    name: string,
  ) => void;
  /** Deletes a session the way the flavor's agent would. */
  readonly deleteSession: (env: IntegrationEnv, id: string) => void;
  /** Throws while any flavor-owned record of the session still exists. */
  readonly assertSessionGone: (env: IntegrationEnv, id: string) => void;
  /** The flag that injects the built-in system prompt on every run. */
  readonly systemFlag: string;
  /** The flag that marks a follow-up (resume) invocation. */
  readonly resumeFlag: string;
  /** The serve flag naming the agent binary ("--goose-binary", ...). */
  readonly binaryFlag: string;
  /** Absolute path to the flavor's Node launcher (bin/glv-*.mjs). */
  readonly binPath: string;
  /** Puts the mock agent binary on PATH; returns a restore closure. */
  readonly mockAgent: () => Promise<() => void>;
  /**
   * Serve argv pointing at a store under the given (fake) HOME for the
   * default-data-dirs suite; implementations may prepare the store first.
   */
  readonly defaultServeArgs: (homeDir: string) => string[];
  /** glv-owned files expected to exist under the default data dir. */
  readonly defaultDbFiles: readonly string[];
  /** Flavor-specific extra assertions on a new run's captured argv. */
  readonly assertNewRunArgs?: (args: string[]) => void;
  /** Flavor-specific extra assertions on a resume run's captured argv. */
  readonly assertResumeRunArgs?: (args: string[]) => void;
};

const IS_WIN = platform() === "win32";

// The Node launcher wraps the CLI in a child process, so a stop must reach
// the whole tree: spawnLauncher puts it in its own process group on POSIX
// and the group is signalled (covering the SIGKILL escalation too); on
// Windows the launcher forwards the signals itself.
const stopProcess = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    const pid = proc.pid;
    if (pid === undefined) return resolve();
    const killTree = (signal: NodeJS.Signals): void => {
      if (IS_WIN) proc.kill(signal);
      else process.kill(-pid, signal);
    };
    const timer = setTimeout(() => killTree("SIGKILL"), 5000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    killTree("SIGTERM");
  });

// Lets pr-state/git-info tests exercise `gh pr view` without a token or
// network.
const ghMockScriptPath = fileURLToPath(
  new URL("./gh-mock-script.ts", import.meta.url),
);
const mockGh = (): Promise<() => void> =>
  mockBin("gh", { file: ghMockScriptPath });

const mockEnv = (prefix: string, mock: MockConfig): Record<string, string> => ({
  [`${prefix}_MOCK_SESSION_NAME`]: mock.sessionName ?? "",
  [`${prefix}_MOCK_SLEEP_MS`]: String(mock.sleepMs ?? 0),
  [`${prefix}_MOCK_EXIT_CODE`]: String(mock.exitCode ?? 0),
  [`${prefix}_MOCK_LINES`]: (mock.lines ?? []).join("\n"),
  [`${prefix}_MOCK_LINE_DELAY_MS`]: String(mock.lineDelayMs ?? 0),
  [`${prefix}_MOCK_WRITE_DB`]: mock.writeDb === true ? "1" : "",
  [`${prefix}_MOCK_CAPTURE_STDIN`]: mock.captureStdin ?? "",
  [`${prefix}_MOCK_CAPTURE_CWD`]: mock.captureCwd ?? "",
  [`${prefix}_MOCK_CAPTURE_ARGS`]: mock.captureArgs ?? "",
  [`${prefix}_MOCK_CAPTURE_ENV`]: mock.captureEnv ?? "",
  [`${prefix}_MOCK_NEVER_CREATE_SESSION`]:
    mock.neverCreateSession === true ? "1" : "",
  ...(mock.acpProviders !== undefined
    ? { [`${prefix}_MOCK_ACP_PROVIDERS`]: mock.acpProviders }
    : {}),
  ...(mock.acpSupportedModels !== undefined
    ? { [`${prefix}_MOCK_ACP_SUPPORTED_MODELS`]: mock.acpSupportedModels }
    : {}),
  ...(mock.acpDelayMs !== undefined
    ? { [`${prefix}_MOCK_ACP_DELAY_MS`]: String(mock.acpDelayMs) }
    : {}),
});

// Subprocess coverage is injected only when the caller pins an env
// (every launcher spawn does); an omitted env must keep Node's
// full-inherit default rather than get a sparse replacement. The
// launcher loads tsx and then the observer in its own process, so the
// observer records tsx's transpiled output with its inline source map
// — the raw NODE_V8_COVERAGE offsets address esbuild's output, not
// the pre-transform source. The vitest provider also wires the
// observer into NODE_OPTIONS of everything the runner spawns, and Node
// processes NODE_OPTIONS before any in-process import, so an
// inherited registration would pre-date tsx and win (the hook
// registers its loader only once). Strip it up front, keeping any
// other options, so the launcher keeps its observer-after-tsx
// ordering without the restart runCliAsMain would otherwise do.
const withSubprocessCoverageEnv = <T extends { env?: NodeJS.ProcessEnv }>(
  options: T,
): T => {
  const rawDir = rawCoverageDir();
  if (rawDir === undefined || options.env === undefined) return options;
  return {
    ...options,
    env: {
      ...options.env,
      NODE_V8_COVERAGE: rawDir,
      [ROOTS_ENV]: ROOT,
      NODE_OPTIONS: stripCoverageHookFromNodeOptions(
        options.env.NODE_OPTIONS ?? "",
      ),
    },
  };
};

const spawnLauncher = (
  binPath: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess =>
  spawn(
    process.execPath,
    [binPath, ...args],
    withSubprocessCoverageEnv({ ...options, detached: !IS_WIN }),
  );

const spawnLauncherSync = (
  binPath: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> =>
  spawnSync(
    process.execPath,
    [binPath, ...args],
    withSubprocessCoverageEnv(options),
  );

// Environment overrides that point os.homedir() — and, on Windows, the
// Known Folders glv resolves its data and config dirs through — at a
// scratch directory, so tests never touch the real profile.
const fakeHomeEnv = (home: string): Record<string, string> =>
  IS_WIN
    ? {
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
      }
    : { HOME: home };

// Platform default locations for glv-owned files under a (fake) home,
// mirroring db-path.ts and config.ts: XDG-style on macOS/Linux, Known
// Folders on Windows.
const defaultDataDir = (home: string, dataDirName: string): string =>
  IS_WIN
    ? join(home, "AppData", "Roaming", dataDirName)
    : join(home, ".local", "share", dataDirName);

const defaultConfigFile = (home: string, dataDirName: string): string =>
  IS_WIN
    ? join(home, "AppData", "Local", dataDirName, "config.json")
    : join(home, ".config", dataDirName, "config.json");

// The config-file shape shared by the cron suites and flavor tests: the
// file is the source of truth, so tests assert on what the UI writes.
type CronConfigFile = { cronJobs?: Record<string, unknown>[] };

// Writes a config file holding exactly these jobs at the flavor's default
// config path, and returns the path (what serve both reads and watches).
// `cronJobs` is `unknown` on purpose: the invalid-shape suites write
// values serve must reject.
const writeCronConfig = (
  home: string,
  dataDirName: string,
  cronJobs: unknown,
): string => {
  const path = defaultConfigFile(home, dataDirName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ cronJobs }, null, 2));
  return path;
};

const readCronConfig = (path: string): CronConfigFile =>
  (existsSync(path)
    ? JSON.parse(readFileSync(path, "utf-8"))
    : {}) as CronConfigFile;

const cronJobIn = (
  path: string,
  name: string,
): Record<string, unknown> | undefined =>
  (readCronConfig(path).cronJobs ?? []).find(
    (job) => (job as { name?: string }).name === name,
  );

// Boots serve with the given argv/env and resolves on exit; a serve still
// alive at the deadline is killed and yields status null — which fails a
// non-zero assertion, because a serve that boots despite an invalid
// config is itself the bug.
const waitForServeExit = async (
  binPath: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<{ status: number | null; stderr: string }> => {
  const proc = spawnLauncher(binPath, args, {
    env: { ...process.env, ...extraEnv },
  });
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      void stopProcess(proc);
      resolve(null);
    }, timeoutMs);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { status, stderr };
};

// Awaits serve refusing to start and returns its stderr for fragment
// checks. Refusal is near-instant normally, but the exit has to be
// awaited on a runner that may be heavily contended (a loaded shard has
// pushed cold serve boots past the 20s default), so the deadline is
// generous — vitest's 120s test ceiling still bounds the wait. A null
// status is the wait timing out — a serve that neither refused nor
// started — named as such instead of `?? 0` dressing it up as a zero
// exit code.
const expectServeRefusal = async (
  binPath: string,
  args: readonly string[],
  extraEnv: Record<string, string>,
): Promise<string> => {
  const { status, stderr } = await waitForServeExit(
    binPath,
    args,
    extraEnv,
    90_000,
  );
  if (status === null)
    throw new Error("serve neither refused nor started within 90s");
  expect(status).not.toBe(0);
  return stderr;
};

const startServer = (
  adapter: FlavorAdapter,
  dbs: Databases,
  port: number,
  extraEnv: Record<string, string> = {},
): { proc: ChildProcess; readStderr: () => string } => {
  let stderr = "";
  const proc = spawnLauncher(
    adapter.binPath,
    ["serve", "-p", String(port), ...adapter.serveArgs(dbs)],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    },
  );
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { proc, readStderr: () => stderr };
};

const startEnv = async (
  adapter: FlavorAdapter,
  prefix: string,
  mock: MockConfig = {},
  homeDir?: string,
  extraEnv: Record<string, string> = {},
): Promise<IntegrationEnv> => {
  const scratchDir = mkdtempSync(join(tmpdir(), prefix));
  const dbs = adapter.createDatabases(scratchDir);
  const uploadsDir = join(scratchDir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const tempDir = join(scratchDir, "tmp");
  mkdirSync(tempDir, { recursive: true });
  const agentMock =
    mock.behaviour === undefined
      ? undefined
      : await mockBin(adapter.mockBinName, mock.behaviour);
  const restoreAgentPath =
    agentMock ??
    (await mockBin(adapter.mockBinName, { file: adapter.mockScriptPath }));
  const restoreGhPath = await mockGh();

  const bootEnv = {
    ...adapter.serverEnv(dbs),
    GLV_UPLOADS_DIR: uploadsDir,
    GLV_TEMP_DIR: tempDir,
    ...(homeDir !== undefined ? fakeHomeEnv(homeDir) : {}),
    ...mockEnv(adapter.mockEnvPrefix, mock),
    ...extraEnv,
  };
  const abortBoot = (err: unknown, stderr: string): never => {
    restoreAgentPath();
    restoreGhPath();
    rmScratch(scratchDir);
    throw new Error(
      `server never started: ${String(err)}; server stderr:\n${stderr}`,
    );
  };
  // findFreePort hands back a port it has already released, and it probes
  // 127.0.0.1 while serve binds the IPv6 wildcard — so a concurrently
  // booting environment (vitest runs whole files in parallel) can claim
  // the port in between and serve dies with EADDRINUSE. Retrying on a
  // fresh port wins that race outright. The same loop races boot against
  // process exit, so a serve that dies immediately fails fast instead of
  // burning waitForHttp's full deadline.
  const bootServer = async (): Promise<{
    baseUrl: string;
    proc: ChildProcess;
    readStderr: () => string;
  }> => {
    for (let attempt = 1; ; attempt++) {
      const port = await findFreePort();
      const baseUrl = `http://localhost:${port}`;
      const { proc, readStderr } = startServer(adapter, dbs, port, bootEnv);
      // `close`, not `exit`: it fires once stderr has flushed too, so the
      // EADDRINUSE check below is guaranteed to see why a dying serve
      // exited.
      const exited = new Promise<never>((_, reject) => {
        proc.once("close", (code) => {
          reject(new Error(`server exited during boot (code ${code})`));
        });
      });
      try {
        await Promise.race([waitForHttp(baseUrl), exited]);
        return { baseUrl, proc, readStderr };
      } catch (err) {
        await stopProcess(proc);
        if (attempt < 3 && readStderr().includes("EADDRINUSE")) continue;
        abortBoot(err, readStderr());
      }
    }
  };
  const { baseUrl, proc, readStderr } = await bootServer();

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const cookieName = sessionCookieName(dbs.authDb);
  await context.addCookies([
    {
      name: cookieName,
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
    restoreAgentPath();
    restoreGhPath();
    const stderr = readStderr();
    if (stderr.trim() !== "") console.error("glv serve stderr:\n" + stderr);
    rmScratch(scratchDir);
  };

  return {
    scratchDir,
    baseUrl,
    cookie: `${cookieName}=${dbs.token}`,
    cookieName,
    serverPid: proc.pid,
    context,
    dbs,
    uploadsDir,
    tempDir,
    serverStderr: readStderr,
    agentMock,
    cleanup,
  };
};

// The per-flavor startEnv wrapper every integration harness binds; the
// only flavor-specific part is the adapter.
const makeStartEnv =
  (adapter: FlavorAdapter): FlavorFixture["startEnv"] =>
  (prefix, mock = {}, homeDir, extraEnv = {}) =>
    startEnv(adapter, prefix, mock, homeDir, extraEnv);

// The scripted agent records every invocation of the mocked binary; the
// session run is the one carrying the resume flag, because other features
// (goose's model picker `acp` probe) invoke the same binary. Delegates to
// the handle's waitForCall, which polls the recorded calls until the
// invocation appears and rejects with the calls recorded so far when the
// budget runs out; undefined when no scripted behaviour is in play.
const waitForAgentRun = async (
  env: IntegrationEnv,
  resumeFlag: string,
  timeoutMs = 10000,
): Promise<MockBinCall | undefined> => {
  const mock = env.agentMock;
  if (mock === undefined) return undefined;
  return mock.waitForCall((call) => call.args.includes(resumeFlag), timeoutMs);
};

// Starts a brand-new run over HTTP (the create-session form's endpoint).
const postNewSession = (
  env: IntegrationEnv,
  workDir: string,
  prompt: string,
): Promise<Response> =>
  authedFetch(env, "/sessions", {
    method: "POST",
    body: new URLSearchParams({ prompt, working_dir: workDir }),
  });

// Queues a follow-up prompt on an existing session over HTTP.
const postFollowUp = (
  env: IntegrationEnv,
  sessionId: string,
  prompt: string,
): Promise<Response> =>
  authedFetch(env, `/sessions/${sessionId}/prompt`, {
    method: "POST",
    body: new URLSearchParams({ prompt }),
    headers: { "HX-Request": "true" },
  });

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

const parseSseData = (data: string): Record<string, unknown> => {
  const parsed = parseJson(data, JsonObject);
  return parsed.ok ? parsed.data : {};
};

// Reads one metadata column from a flavor's SQLite store table ("sessions"
// for goose's agent DB, "session_meta" for claude's sidecar).
const readStoreField = (
  dbPath: string,
  table: string,
  field: string,
  id: string,
): unknown => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db
    .prepare(`SELECT ${field} AS v FROM ${table} WHERE id = ?`)
    .get(id) as { v: unknown } | undefined;
  db.close();
  return row?.v;
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
// The server keeps streams open indefinitely, so the reader is always
// released.
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

export type {
  CronConfigFile,
  Databases,
  FlavorAdapter,
  FlavorFixture,
  IntegrationEnv,
  MessageSeed,
  MockConfig,
  SessionSeed,
  SseEvent,
};
export {
  authedFetch,
  baseDatabases,
  collectSse,
  cronJobIn,
  dbOverrideArgs,
  defaultConfigFile,
  defaultDataDir,
  expectServeRefusal,
  fakeHomeEnv,
  findFreePort,
  flagValue,
  IS_WIN,
  makeStartEnv,
  parseSseData,
  postFollowUp,
  postNewSession,
  ROOT,
  readCronConfig,
  readStoreField,
  rmScratch,
  spawnLauncher,
  spawnLauncherSync,
  startEnv,
  stopProcess,
  subdirCount,
  waitForAgentRun,
  waitForArgs,
  waitForFile,
  waitForHttp,
  waitForJsonFile,
  waitForServeExit,
  withPage,
  writeCronConfig,
};
