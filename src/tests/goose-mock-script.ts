import { DatabaseSync } from "node:sqlite";

// Stand-in for the real goose binary, configurable through environment so the
// integration harness can exercise the runner's queueing, stop, error and
// streaming paths without a real LLM. glv spawns `goose run` with the prompt on
// stdin; this mock mirrors enough of that contract for the viewer to behave
// realistically.
//
// Resume vs new session is detected from argv: a `--session-id` flag means a
// follow-up (resume) on an existing session, so no session row is inserted —
// only output is emitted. Without it the mock creates the session row goose
// would have created (working_dir = its own cwd), letting the server's poll
// detect and re-key the run onto the real id.
//
// Configuration (read fresh per invocation):
//   GOOSE_SESSIONS_DB        — sessions database path
//   GOOSE_MOCK_SESSION_NAME  — name written into a new session row
//   GOOSE_MOCK_SLEEP_MS      — delay before emitting output (keeps a run
//                              "running" for concurrency/stop tests)
//   GOOSE_MOCK_EXIT_CODE     — process exit code (non-zero → runner error)
//   GOOSE_MOCK_LINES         — newline-separated NDJSON lines to emit
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_LINE = JSON.stringify({
  role: "assistant",
  content: [{ type: "text", text: "mock goose reply" }],
});

const insertSession = (): void => {
  const dbPath = process.env.GOOSE_SESSIONS_DB;
  const sessionName = process.env.GOOSE_MOCK_SESSION_NAME ?? "";
  if (dbPath === undefined) return;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const id = `mock-${process.pid}-${Date.now()}`;
  const sql =
    "INSERT INTO sessions (id, name, session_type, working_dir, " +
    "created_at, updated_at) " +
    "VALUES (?, ?, 'user', ?, datetime('now'), datetime('now'))";
  db.prepare(sql).run(id, sessionName, process.cwd());
  db.close();
};

const emit = (): void => {
  const custom = process.env.GOOSE_MOCK_LINES ?? "";
  const lines = custom === "" ? [DEFAULT_LINE] : custom.split("\n");
  for (const line of lines) if (line !== "") console.log(line);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const isResume = args.includes("--session-id");

  // Insert first so the server's session poll detects the row promptly even
  // when a long sleep keeps the process alive afterwards.
  if (!isResume) insertSession();

  const sleepMs = Number(process.env.GOOSE_MOCK_SLEEP_MS ?? 0);
  if (sleepMs > 0) await sleep(sleepMs);

  emit();
  process.exit(Number(process.env.GOOSE_MOCK_EXIT_CODE ?? 0));
};

void main();
