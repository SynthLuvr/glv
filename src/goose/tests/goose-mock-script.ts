import { DatabaseSync } from "node:sqlite";
import {
  captureStdinTo,
  captureTo,
  linesFromEnv,
  sleep,
  spawnLongChild,
  streamLines,
  trapSignals,
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

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const isResume = args.includes("--session-id");
  trapSignals("GOOSE_MOCK_TRAP_SIGNALS");

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
  spawnLongChild("GOOSE_MOCK_SPAWN_CHILD");

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
