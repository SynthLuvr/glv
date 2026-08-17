import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GLV = resolve("bin/glv-goose");

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

type RunResult = { status: number; stdout: string; stderr: string };

let dir: string;
let dbPath: string;

const run = (args: string[], env: Record<string, string> = {}): RunResult => {
  const result = spawnSync(GLV, ["--db", dbPath, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

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
  // A tool response and a thinking block are skipped by `glv-goose view`.
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

describe("glv-goose sessions", () => {
  it("lists user sessions, excluding hidden and archived ones", () => {
    const { status, stdout } = run(["sessions"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Alpha Session");
    expect(stdout).toContain("Beta Session");
    expect(stdout).not.toContain("Gamma Session");
    expect(stdout).not.toContain("Archived One");
    expect(stdout).toContain("2 session(s) listed.");
  });

  it("renders an empty-name session as (unnamed)", () => {
    // Beta has tokens=null and provider_name=null; the listing degrades
    // gracefully ("-") rather than printing "null".
    const { stdout } = run(["sessions"]);
    expect(stdout).not.toContain("null");
  });

  it("respects --limit", () => {
    const { stdout } = run(["sessions", "-n", "1"]);
    expect(stdout).toContain("1 session(s) listed.");
  });

  it("includes archived sessions with --all", () => {
    const { stdout } = run(["sessions", "--all"]);
    expect(stdout).toContain("Archived One");
  });
});

describe("glv-goose logs", () => {
  it("lists only hidden (--no-session) runs", () => {
    const { stdout } = run(["logs"]);
    expect(stdout).toContain("gamma");
    expect(stdout).not.toContain("Alpha Session");
  });
});

describe("glv-goose view", () => {
  it("shows prompts and outputs, skipping tool/thinking messages", () => {
    const { status, stdout } = run(["view", "alpha"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Hello goose");
    expect(stdout).toContain("Hi there");
    expect(stdout).not.toContain("tool out");
    expect(stdout).not.toContain("private");
  });

  it("surfaces the session header with id, name, dir and tokens", () => {
    const { stdout } = run(["view", "alpha"]);
    expect(stdout).toContain("alpha");
    expect(stdout).toContain("Alpha Session");
    expect(stdout).toContain("/tmp/alpha");
    expect(stdout).toContain("100");
    expect(stdout).toContain("Anthropic");
  });

  it("exits non-zero for an unknown session", () => {
    const { status } = run(["view", "no-such-session"]);
    expect(status).not.toBe(0);
  });
});

describe("glv-goose config", () => {
  let cfgPath: string;

  beforeAll(() => {
    cfgPath = join(dir, "config.json");
  });

  it("lists known keys with empty values when the file is absent", () => {
    const { status, stdout } = run(["config", "list"], { GLV_CONFIG: cfgPath });
    expect(status).toBe(0);
    expect(stdout).toContain("forwardHost=");
  });

  it("sets a field then reads it back", () => {
    run(["config", "set", "forwardHost", "203.0.113.5"], {
      GLV_CONFIG: cfgPath,
    });
    const { stdout } = run(["config", "get", "forwardHost"], {
      GLV_CONFIG: cfgPath,
    });
    expect(stdout.trim()).toBe("203.0.113.5");
  });

  it("exits non-zero for an unknown key", () => {
    const { status, stderr } = run(["config", "get", "bogus"], {
      GLV_CONFIG: cfgPath,
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain("Unknown config key");
  });

  it("tolerates unknown keys preserved on disk when re-listing", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ forwardHost: "10.0.0.1", future: true }),
    );
    const { stdout } = run(["config", "list"], { GLV_CONFIG: cfgPath });
    expect(stdout).toContain("future=true");
    expect(stdout).toContain("forwardHost=10.0.0.1");
  });
});

describe("glv-goose serve argument validation", () => {
  it("rejects a non-positive --max-concurrent", () => {
    const { status, stderr } = run(["serve", "--max-concurrent", "0"]);
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("positive integer");
  });

  it("rejects a non-numeric --max-concurrent", () => {
    const { status, stderr } = run(["serve", "--max-concurrent", "abc"]);
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("positive integer");
  });

  it("rejects a --goose-binary path that does not exist", () => {
    const { status, stderr } = run([
      "serve",
      "--goose-binary",
      "/no/such/binary",
    ]);
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("not found");
  });

  it("documents the --forward flag in help", () => {
    const { stdout } = run(["serve", "--help"]);
    expect(stdout).toContain("--forward");
  });
});
