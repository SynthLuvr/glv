import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMetaDb } from "../../glv/session-meta.js";
import { insertMessages, insertSessions } from "./integration-harness";

const GLV = resolve("bin/glv-claude");

type RunResult = { status: number; stdout: string; stderr: string };

let dir: string;
let projectsDir: string;
let metaDb: string;

const run = (args: string[], env: Record<string, string> = {}): RunResult => {
  const result = spawnSync(
    GLV,
    ["--projects-dir", projectsDir, "--meta-db", metaDb, ...args],
    {
      env: { ...process.env, ...env },
      encoding: "utf-8",
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

// Seeds claude-shaped transcripts the CLI can read. Seeded directly because
// these tests drive the binary, not the server.
const seed = (): void => {
  insertSessions(projectsDir, [
    { id: "alpha", name: "Alpha Session", workingDir: "/tmp/alpha" },
    { id: "beta", name: "", workingDir: "/tmp/beta" },
    { id: "archived", name: "Archived One", workingDir: "/tmp/arch" },
  ]);
  insertMessages(projectsDir, "alpha", [
    { role: "user", content: [{ type: "text", text: "Hello claude" }] },
    { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    // A tool result and a thinking block are skipped by glv-claude view.
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          content: [{ type: "text", text: "tool out" }],
          is_error: false,
        },
      ],
    },
    { role: "assistant", content: [{ type: "thinking", thinking: "private" }] },
  ]);

  // Archive state lives in the glv-owned sidecar, not claude's transcripts.
  const db = openMetaDb(metaDb);
  db.prepare(
    "INSERT INTO session_meta (id, archived_at) VALUES (?, CURRENT_TIMESTAMP)",
  ).run("archived");
  db.close();
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-cli-"));
  projectsDir = join(dir, "projects");
  metaDb = join(dir, "meta.db");
  seed();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("glv-claude sessions", () => {
  it("lists sessions, excluding archived ones", () => {
    const { status, stdout } = run(["sessions"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Alpha Session");
    expect(stdout).toContain("(unnamed)");
    expect(stdout).not.toContain("Archived One");
    expect(stdout).toContain("2 session(s) listed.");
  });

  it("degrades gracefully for null tokens and provider", () => {
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

describe("glv-claude view", () => {
  it("shows prompts and outputs, skipping tool/thinking messages", () => {
    const { status, stdout } = run(["view", "alpha"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Hello claude");
    expect(stdout).toContain("Hi there");
    expect(stdout).not.toContain("tool out");
    expect(stdout).not.toContain("private");
  });

  it("surfaces the session header with id, name and dir", () => {
    const { stdout } = run(["view", "alpha"]);
    expect(stdout).toContain("alpha");
    expect(stdout).toContain("Alpha Session");
    expect(stdout).toContain("/tmp/alpha");
    expect(stdout).toContain("claude");
  });

  it("exits non-zero for an unknown session", () => {
    const { status } = run(["view", "no-such-session"]);
    expect(status).not.toBe(0);
  });
});

describe("glv-claude config", () => {
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

describe("glv-claude serve argument validation", () => {
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

  it("rejects a --claude-binary path that does not exist", () => {
    const { status, stderr } = run([
      "serve",
      "--claude-binary",
      "/no/such/binary",
    ]);
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("not found");
  });

  it("rejects an invalid --permission-mode", () => {
    const { status, stderr } = run(["serve", "--permission-mode", "yolo"]);
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("permission");
  });

  it("documents the --forward flag in help", () => {
    const { stdout } = run(["serve", "--help"]);
    expect(stdout).toContain("--forward");
  });
});
