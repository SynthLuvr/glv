import { DatabaseSync } from "node:sqlite";

// Stand-in for the real goose binary. glv spawns `goose run` with the prompt on
// stdin, then polls the sessions database for a new row in the working
// directory. This mock inserts that row (working_dir = its own cwd), emits one
// NDJSON stream line, and exits 0 — mirroring real goose. The sessions DB path
// and session name arrive through the environment.
const dbPath = process.env.GOOSE_SESSIONS_DB;
const sessionName = process.env.GOOSE_MOCK_SESSION_NAME ?? "";

if (dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  const id = `mock-${process.pid}-${Date.now()}`;
  const sql =
    "INSERT INTO sessions (id, name, session_type, working_dir, " +
    "created_at, updated_at) " +
    "VALUES (?, ?, 'user', ?, datetime('now'), datetime('now'))";
  db.prepare(sql).run(id, sessionName, process.cwd());
  db.close();
}

console.log(
  JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "mock goose reply" }],
  }),
);
