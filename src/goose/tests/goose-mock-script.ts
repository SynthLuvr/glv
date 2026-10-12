import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  captureStdinTo,
  captureTo,
  linesFromEnv,
  sleep,
  streamLines,
} from "../../glv/tests/mock-common.js";

// Stand-in for the real goose binary. A `--session-id` flag means a resume
// (follow-up), so no new session row is inserted. Behaviour is driven by env
// vars (sleep, exit code, output lines), read fresh per invocation.
const DEFAULT_LINE = JSON.stringify({
  role: "assistant",
  content: [{ type: "text", text: "mock goose reply" }],
});

// Returns the new session's id so emitted lines can be committed to it.
const insertSession = (): string | undefined => {
  const dbPath = process.env.GOOSE_SESSIONS_DB;
  const sessionName = process.env.GOOSE_MOCK_SESSION_NAME ?? "";
  if (dbPath === undefined) return undefined;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const id = `mock-${process.pid}-${Date.now()}`;
  const sql =
    "INSERT INTO sessions (id, name, session_type, working_dir, " +
    "created_at, updated_at) " +
    "VALUES (?, ?, 'user', ?, datetime('now'), datetime('now'))";
  db.prepare(sql).run(id, sessionName, process.cwd());
  db.close();
  return id;
};

const sessionIdFromArgs = (args: string[]): string | undefined => {
  const idx = args.indexOf("--session-id");
  return idx >= 0 ? args[idx + 1] : undefined;
};

// An ephemeral invocation (`run --no-session`, the behind-the-scenes
// suggestions ask). Mirrors real goose 1.53.0: a hidden-type session row
// is still inserted (the product's cleanup sweep deletes it), no message
// rows are committed, and output lines come from the ephemeral fixture
// env. Every invocation appends its argv to the ephemeral log.
const insertHiddenSession = (): string | undefined => {
  const dbPath = process.env.GOOSE_SESSIONS_DB;
  if (dbPath === undefined) return undefined;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const id = `mock-hidden-${process.pid}-${Date.now()}`;
  db.prepare(
    "INSERT INTO sessions (id, name, session_type, working_dir, " +
      "created_at, updated_at) " +
      "VALUES (?, '', 'hidden', ?, datetime('now'), datetime('now'))",
  ).run(id, process.cwd());
  db.close();
  return id;
};

const appendEphemeralLog = (args: string[]): void => {
  const path = process.env.GOOSE_MOCK_EPHEMERAL_LOG;
  if (path === undefined || path === "") return;
  appendFileSync(path, JSON.stringify(args) + "\n");
};

const ephemeralLines = (): string[] => {
  const custom = process.env.GOOSE_MOCK_EPHEMERAL_LINES ?? "";
  if (custom === "") return [DEFAULT_LINE];
  return custom.split("\n").filter((line) => line !== "");
};

// Persists a streamed NDJSON envelope as a committed message row, the way
// goose writes its transcript to the sessions DB.
const commitMessage = (
  db: DatabaseSync,
  sessionId: string,
  line: string,
  ts: number,
): void => {
  let role = "assistant";
  let content = line;
  try {
    const parsed = JSON.parse(line) as { role?: unknown; content?: unknown };
    if (typeof parsed.role === "string") role = parsed.role;
    if (parsed.content !== undefined) content = JSON.stringify(parsed.content);
  } catch {
    // malformed JSON is kept as the raw line text
  }
  db.prepare(
    "INSERT INTO messages (message_id, session_id, role, content_json, " +
      "created_timestamp, timestamp) VALUES (?, ?, ?, ?, ?, datetime('now'))",
  ).run(null, sessionId, role, content, ts);
};

// Streams each line to stdout while persisting it to the sessions DB, the
// way goose writes its transcript incrementally.
const streamAndCommit = async (
  sessionId: string,
  lines: string[],
  delay: number,
): Promise<void> => {
  const dbPath = process.env.GOOSE_SESSIONS_DB;
  if (dbPath === undefined) return streamLines(lines, delay);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  await streamLines(lines, delay, (line, ts) =>
    commitMessage(db, sessionId, line, ts),
  );
  db.close();
};

// Minimal ACP server for goose's unstable provider-catalogue extensions:
// the New Session model picker runs `<goose-binary> acp` and asks for the
// provider/model inventory. Fixtures come from GOOSE_MOCK_ACP_* env vars
// (JSON); with no fixture set the _goose methods answer "method not found",
// matching a goose too old for the extensions — the picker must degrade to
// config-only choices. Runs before anything else so `acp` never touches the
// sessions DB or streams run output.
const runAcpMode = async (): Promise<void> => {
  const parseEnvJson = (name: string): unknown => {
    const raw = process.env[name] ?? "";
    if (raw === "") return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };
  // Optional stall before the conversation answers, simulating a real
  // agent binary taking seconds to enumerate its catalogue.
  const delayMs = Number(process.env.GOOSE_MOCK_ACP_DELAY_MS);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const providers = parseEnvJson("GOOSE_MOCK_ACP_PROVIDERS");
  const supported = parseEnvJson("GOOSE_MOCK_ACP_SUPPORTED_MODELS") as
    | Record<string, readonly string[]>
    | undefined;

  const write = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: number, result: unknown): void =>
    write({ jsonrpc: "2.0", id, result });
  const fail = (id: number): void =>
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let msg: { id?: unknown; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.method !== "string") return;
    const id = typeof msg.id === "number" ? msg.id : undefined;
    switch (msg.method) {
      case "initialize":
        if (id !== undefined)
          reply(id, {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "goose-mock", version: "0" },
          });
        return;
      case "_goose/unstable/providers/list":
        if (id === undefined) return;
        if (providers === undefined) fail(id);
        else reply(id, providers);
        return;
      case "_goose/unstable/providers/supported-models/list": {
        if (id === undefined) return;
        const providerId = (msg.params as { providerId?: unknown } | undefined)
          ?.providerId;
        const models =
          typeof providerId === "string" ? supported?.[providerId] : undefined;
        if (Array.isArray(models)) reply(id, { providerId, models });
        else fail(id);
        return;
      }
      default:
        return; // notifications and unknown methods get no reply
    }
  });
  // The caller kills this process when done (closing stdin); the timer is
  // only a guard against a stdin that never closes.
  const guard = setTimeout(() => lines.close(), 30_000);
  guard.unref();
  await new Promise<void>((resolve) => {
    lines.on("close", resolve);
  });
  process.exit(0);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args[0] === "acp") {
    await runAcpMode();
    return;
  }
  // The ephemeral suggestions ask: log, insert the hidden row real goose
  // leaves, stream the fixture lines, and never commit message rows.
  if (args.includes("--no-session")) {
    appendEphemeralLog(args);
    insertHiddenSession();
    await captureStdinTo("GOOSE_MOCK_CAPTURE_STDIN");
    await streamLines(ephemeralLines(), 0);
    process.exit(0);
  }

  const isResume = args.includes("--session-id");

  // Insert first so the server's session poll detects the row promptly even
  // when a long sleep keeps the process alive afterwards. Tests that need a
  // create-timeout (session-establishment failure) skip the insert entirely.
  const sessionId =
    isResume || process.env.GOOSE_MOCK_NEVER_CREATE_SESSION === "1"
      ? sessionIdFromArgs(args)
      : insertSession();

  await captureStdinTo("GOOSE_MOCK_CAPTURE_STDIN");
  captureTo("GOOSE_MOCK_CAPTURE_CWD", process.cwd());
  captureTo("GOOSE_MOCK_CAPTURE_ARGS", JSON.stringify(args));

  const sleepMs = Number(process.env.GOOSE_MOCK_SLEEP_MS ?? 0);
  if (sleepMs > 0) await sleep(sleepMs);

  const lines = linesFromEnv("GOOSE", DEFAULT_LINE);
  const delay = Number(process.env.GOOSE_MOCK_LINE_DELAY_MS ?? 0);

  if (process.env.GOOSE_MOCK_WRITE_DB === "1" && sessionId !== undefined)
    await streamAndCommit(sessionId, lines, delay);
  else await streamLines(lines, delay);

  process.exit(Number(process.env.GOOSE_MOCK_EXIT_CODE ?? 0));
};

void main();
