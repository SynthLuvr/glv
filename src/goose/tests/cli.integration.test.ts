import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRunner, runCliSuite } from "../../glv/tests/suites/cli.suite.js";
import { gooseFixture } from "./integration-harness.js";

const GLV = resolve("bin/glv-goose.mjs");

// Mirrors goose's sessions schema so the CLI has something to read. Seeded
// directly because these tests drive the binary, not the server.
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

let dir: string;
let dbPath: string;

const seed = (): void => {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const insSession = db.prepare(
    "INSERT INTO sessions (id, name, session_type, working_dir, updated_at, total_tokens, provider_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insSession.run(
    "alpha",
    "Alpha Session",
    "user",
    "/tmp/alpha",
    "2026-07-13 10:00:00",
    100,
    "Anthropic",
  );
  insSession.run(
    "beta",
    "Beta Session",
    "user",
    "/tmp/beta",
    "2026-07-13 11:00:00",
    null,
    null,
  );
  insSession.run(
    "gamma",
    "",
    "hidden",
    "/tmp/gamma",
    "2026-07-13 09:00:00",
    50,
    null,
  );
  // An archived user session stays out of the default listing.
  insSession.run(
    "archived",
    "Archived One",
    "user",
    "/tmp/arch",
    "2026-07-12 08:00:00",
    5,
    null,
  );
  db.prepare(
    "UPDATE sessions SET archived_at = datetime('now') WHERE id = 'archived'",
  ).run();

  const insMsg = db.prepare(
    "INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?, ?)",
  );
  insMsg.run(
    null,
    "alpha",
    "user",
    JSON.stringify([{ type: "text", text: "Hello goose" }]),
    1,
  );
  insMsg.run(
    null,
    "alpha",
    "assistant",
    JSON.stringify([{ type: "text", text: "Hi there" }]),
    2,
  );
  // A tool response and a thinking block are skipped by view.
  insMsg.run(
    null,
    "alpha",
    "user",
    JSON.stringify([
      {
        type: "toolResponse",
        toolResult: {
          value: { content: [{ type: "text", text: "tool out" }] },
        },
      },
    ]),
    3,
  );
  insMsg.run(
    null,
    "alpha",
    "assistant",
    JSON.stringify([{ type: "thinking", thinking: "private" }]),
    4,
  );
  db.close();
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-cli-"));
  dbPath = join(dir, "sessions.db");
  seed();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = makeRunner(GLV, () => ["--db", dbPath]);

runCliSuite(gooseFixture, {
  run,
  cfgDir: () => dir,
  assertViewHeader: (stdout) => {
    expect(stdout).toContain("100");
    expect(stdout).toContain("Anthropic");
  },
});

// goose-only: hidden sessions stay out of listings and surface via logs.
describe("glv-goose hidden sessions", () => {
  it("excludes hidden sessions from the default listing", () => {
    const { stdout } = run(["sessions"]);
    expect(stdout).toContain("Beta Session");
    expect(stdout).not.toContain("Gamma Session");
  });

  it("lists only hidden (--no-session) runs via logs", () => {
    const { stdout } = run(["logs"]);
    expect(stdout).toContain("gamma");
    expect(stdout).not.toContain("Alpha Session");
  });
});
