import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { listMessages, openDb } from "../db.js";

const SCHEMA = `
CREATE TABLE sessions (
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
CREATE TABLE messages (
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

const setupDb = (journalMode?: string): { dir: string; dbPath: string } => {
  const dir = mkdtempSync(join(tmpdir(), "glv-freshness-"));
  const dbPath = join(dir, "sessions.db");
  const setup = new DatabaseSync(dbPath);
  if (journalMode !== undefined)
    setup.exec(`PRAGMA journal_mode = ${journalMode}`);
  setup.exec(SCHEMA);
  setup
    .prepare(
      "INSERT INTO sessions (id, name, session_type, working_dir) " +
        "VALUES (?, ?, ?, ?)",
    )
    .run("fresh", "Fresh Session", "user", "/tmp/fresh");
  setup.close();
  return { dir, dbPath };
};

// A second connection — standing in for goose's process — commits a message.
const writeMessage = (dbPath: string): void => {
  const goose = new DatabaseSync(dbPath);
  goose
    .prepare(
      "INSERT INTO messages (session_id, role, content_json, " +
        "created_timestamp) VALUES (?, ?, ?, ?)",
    )
    .run(
      "fresh",
      "assistant",
      JSON.stringify([{ type: "text", text: "from another connection" }]),
      Date.now(),
    );
  goose.close();
};

// glv serve holds a long-lived database connection while goose commits new
// message rows from a separate process. This confirms that re-running a
// prepared statement on the held connection picks up goose's committed writes,
// so listMessages stays fresh without reopening the database per request.
describe("cross-connection database freshness", () => {
  it("a long-lived connection sees rows written from another connection", () => {
    const { dir, dbPath } = setupDb();
    const viewer = openDb(dbPath, { readOnly: false });
    try {
      expect(listMessages(viewer, "fresh")).toHaveLength(0);

      writeMessage(dbPath);
      expect(listMessages(viewer, "fresh")).toHaveLength(1);

      // additional writes are visible without reopening the connection
      writeMessage(dbPath);
      expect(listMessages(viewer, "fresh")).toHaveLength(2);
    } finally {
      viewer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays fresh under WAL journaling (goose's default mode)", () => {
    const { dir, dbPath } = setupDb("WAL");
    const viewer = openDb(dbPath, { readOnly: false });
    try {
      const mode = viewer.prepare("PRAGMA journal_mode").get();
      if (
        !(
          typeof mode === "object" &&
          mode !== null &&
          "journal_mode" in mode &&
          typeof mode.journal_mode === "string"
        )
      )
        throw new Error("PRAGMA journal_mode did not return a row");
      expect(mode.journal_mode).toBe("wal");

      expect(listMessages(viewer, "fresh")).toHaveLength(0);

      writeMessage(dbPath);
      expect(listMessages(viewer, "fresh")).toHaveLength(1);
    } finally {
      viewer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
