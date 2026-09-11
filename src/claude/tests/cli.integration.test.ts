import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMetaDb } from "../../glv/session-meta.js";
import { makeRunner, runCliSuite } from "../../glv/tests/suites/cli.suite.js";
import {
  claudeFixture,
  insertMessages,
  insertSessions,
} from "./integration-harness.js";

const GLV = resolve("bin/glv-claude.mjs");

let dir: string;
let projectsDir: string;
let metaDb: string;

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
    // A tool result and a thinking block are skipped by view.
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
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private" }],
    },
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

const run = makeRunner(GLV, () => [
  "--projects-dir",
  projectsDir,
  "--meta-db",
  metaDb,
]);

runCliSuite(claudeFixture, {
  run,
  assertViewHeader: (stdout) => {
    expect(stdout).toContain("claude");
  },
});

// claude-only: the unnamed fallback and permission-mode validation.
describe("glv-claude sessions — unnamed", () => {
  it("renders an empty-name session as (unnamed)", () => {
    const { stdout } = run(["sessions"]);
    expect(stdout).toContain("(unnamed)");
  });
});

describe("glv-claude serve argument validation — permissions", () => {
  it("rejects an invalid --permission-mode", () => {
    const { status, stderr } = run(["serve", "--permission-mode", "yolo"]);
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("permission");
  });
});
