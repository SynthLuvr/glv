import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GLV = resolve("bin/glv");

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

const seed = (db: DatabaseSync): void => {
  db.exec(SCHEMA);
  const insSession = db.prepare(
    "INSERT INTO sessions (id, name, session_type, working_dir, updated_at, total_tokens) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insSession.run(
    "alpha",
    "Alpha Session",
    "user",
    "/tmp/alpha",
    "2026-07-13 10:00:00",
    100,
  );
  insSession.run(
    "beta",
    "Beta Session",
    "user",
    "/tmp/beta",
    "2026-07-13 09:00:00",
    50,
  );
  insSession.run(
    "silent",
    "Silent Run",
    "hidden",
    "/tmp/silent",
    "2026-07-13 11:00:00",
    10,
  );
  const insMessage = db.prepare(
    "INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)",
  );
  insMessage.run(
    "alpha",
    "user",
    JSON.stringify([{ type: "text", text: "What is goose?" }]),
    1,
  );
  insMessage.run(
    "alpha",
    "assistant",
    JSON.stringify([
      { type: "thinking", thinking: "hmm" },
      { type: "toolRequest", id: "1" },
    ]),
    2,
  );
  insMessage.run(
    "alpha",
    "user",
    JSON.stringify([{ type: "toolResponse", id: "1" }]),
    3,
  );
  insMessage.run(
    "alpha",
    "assistant",
    JSON.stringify([{ type: "text", text: "Goose is an agent" }]),
    4,
  );
};

let dir = "";
let dbPath = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-it-"));
  dbPath = join(dir, "sessions.db");
  const db = new DatabaseSync(dbPath);
  seed(db);
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type RunResult = { stdout: string; stderr: string; status: number | null };

const run = (...args: string[]): RunResult => {
  const res = spawnSync(GLV, ["--db", dbPath, ...args], { encoding: "utf-8" });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
  };
};

describe("glv sessions", () => {
  it("lists user sessions, excluding hidden ones", () => {
    const { stdout } = run("sessions");
    expect(stdout).toContain("Alpha Session");
    expect(stdout).toContain("Beta Session");
    expect(stdout).not.toContain("Silent Run");
    expect(stdout).toContain("session(s) listed");
  });

  it("respects --limit", () => {
    const { stdout } = run("sessions", "--limit", "1");
    expect(stdout).toContain("Alpha Session");
    expect(stdout).not.toContain("Beta Session");
  });
});

describe("glv logs", () => {
  it("lists --no-session (hidden) runs only", () => {
    const { stdout } = run("logs");
    expect(stdout).toContain("Silent Run");
    expect(stdout).not.toContain("Alpha Session");
  });
});

describe("glv view", () => {
  it("shows prompts and outputs, skipping tool/thinking messages", () => {
    const { stdout } = run("view", "alpha");
    expect(stdout).toContain("Session: alpha");
    expect(stdout).toContain("PROMPT");
    expect(stdout).toContain("What is goose?");
    expect(stdout).toContain("OUTPUT");
    expect(stdout).toContain("Goose is an agent");
  });

  it("exits non-zero for an unknown session", () => {
    const { stderr, status } = run("view", "missing");
    expect(status).toBe(1);
    expect(stderr).toContain("Session not found");
  });
});

describe("glv serve options", () => {
  it("accepts --max-concurrent and --goose-binary flags", () => {
    const { stdout } = run("serve", "--help");
    expect(stdout).toContain("--max-concurrent");
    expect(stdout).toContain("--goose-binary");
  });

  it("documents --forward", () => {
    const { stdout } = run("serve", "--help");
    expect(stdout).toContain("--forward");
  });
});

describe("glv serve argument validation", () => {
  it("rejects a non-positive --max-concurrent", () => {
    const { stderr, status } = run("serve", "--max-concurrent", "0");
    expect(status).toBe(1);
    expect(stderr).toContain("max-concurrent");
  });

  it("rejects a non-numeric --max-concurrent", () => {
    const { stderr, status } = run("serve", "--max-concurrent", "abc");
    expect(status).toBe(1);
    expect(stderr).toContain("max-concurrent");
  });

  it("rejects a --goose-binary path that does not exist", () => {
    const { stderr, status } = run("serve", "--goose-binary", "/no/such/goose");
    expect(status).toBe(1);
    expect(stderr).toContain("goose-binary");
  });
});
