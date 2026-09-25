import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertSessions as insertClaudeSessions } from "../../claude/tests/integration-harness.js";
import {
  insertMessages as insertGooseMessages,
  insertSessions as insertGooseSessions,
  SESSIONS_SCHEMA,
} from "../../goose/tests/integration-harness.js";
import { ROOT, rmScratch, spawnLauncherSync } from "./harness.js";

// The merged CLI: one program listing and viewing sessions from every
// available agent, with namespaced ids end to end.

const GLV = join(ROOT, "bin", "glv.mjs");

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "glv-cli-"));
  const db = new DatabaseSync(join(scratch, "sessions.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SESSIONS_SCHEMA);
  db.close();
  insertGooseSessions(join(scratch, "sessions.db"), [
    {
      id: "cli-goose",
      name: "CLI Goose Session",
      workingDir: join(scratch, "work"),
    },
    {
      id: "cli-hidden",
      name: "Hidden Goose Run",
      workingDir: join(scratch, "work"),
    },
  ]);
  const mark = new DatabaseSync(join(scratch, "sessions.db"));
  mark
    .prepare("UPDATE sessions SET session_type = 'hidden' WHERE id = ?")
    .run("cli-hidden");
  mark.close();
  insertGooseMessages(join(scratch, "sessions.db"), "cli-goose", [
    { role: "user", content: "goose cli prompt" },
  ]);
  mkdirSync(join(scratch, "projects"), { recursive: true });
  insertClaudeSessions(join(scratch, "projects"), [
    {
      id: "cli-claude",
      name: "CLI Claude Session",
      workingDir: join(scratch, "work"),
    },
  ]);
});

afterAll(() => {
  rmScratch(scratch);
});

const run = (
  args: readonly string[],
): { status: number; stdout: string; stderr: string } => {
  const result = spawnLauncherSync(GLV, args, {
    cwd: ROOT,
    encoding: "utf-8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const globals = (): string[] => [
  "--goose-db",
  join(scratch, "sessions.db"),
  "--projects-dir",
  join(scratch, "projects"),
];

describe("glv sessions", () => {
  it("lists every agent's sessions with namespaced ids", () => {
    const { status, stdout } = run([...globals(), "sessions"]);
    expect(status).toBe(0);
    expect(stdout).toContain("goose:cli-goose");
    expect(stdout).toContain("claude:cli-claude");
    expect(stdout).toContain("2 session(s) listed.");
  });

  it("filters to one agent with --agent", () => {
    const { stdout } = run([...globals(), "sessions", "--agent", "claude"]);
    expect(stdout).toContain("claude:cli-claude");
    expect(stdout).not.toContain("goose:cli-goose");
    expect(stdout).toContain("1 session(s) listed.");
  });

  it("rejects an unknown agent", () => {
    const { status, stderr } = run(["sessions", "--agent", "cursor"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("must be one of");
  });

  it("skips an agent whose store is missing, without error", () => {
    const { status, stdout } = run([
      "--goose-db",
      join(scratch, "missing.db"),
      "--projects-dir",
      join(scratch, "projects"),
      "sessions",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain("claude:cli-claude");
    expect(stdout).not.toContain("goose:");
  });
});

describe("glv view", () => {
  it("shows a namespaced session from either agent", () => {
    const { status, stdout } = run([...globals(), "view", "claude:cli-claude"]);
    expect(status).toBe(0);
    expect(stdout).toContain("CLI Claude Session");
  });

  it("exits non-zero for a raw id", () => {
    const { status } = run([...globals(), "view", "cli-goose"]);
    expect(status).not.toBe(0);
  });
});

describe("glv logs", () => {
  it("lists goose hidden sessions", () => {
    const { status, stdout } = run([...globals(), "logs"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Hidden Goose Run");
  });
});
