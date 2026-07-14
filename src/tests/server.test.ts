import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server.js";

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
  archived_at TIMESTAMP
);
`;

const seed = (db: DatabaseSync): void => {
  db.exec(SCHEMA);
  const insert = db.prepare(
    "INSERT INTO sessions (id, name, session_type, working_dir, updated_at, total_tokens, provider_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    "alpha",
    "Alpha Session",
    "user",
    "/tmp/alpha",
    "2026-07-13 10:00:00",
    1234,
    "anthropic",
  );
  insert.run(
    "beta",
    "Beta Session",
    "user",
    "/tmp/beta",
    "2026-07-13 09:00:00",
    50,
    null,
  );
  insert.run(
    "silent",
    "Silent Run",
    "hidden",
    "/tmp/silent",
    "2026-07-13 11:00:00",
    10,
    null,
  );
};

let db: DatabaseSync;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-web-it-"));
  db = new DatabaseSync(join(dir, "sessions.db"));
  seed(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const renderRoot = async (): Promise<string> => {
  const res = await createApp(db).request("/");
  return res.text();
};

describe("web viewer GET /", () => {
  it("lists user sessions, excluding hidden ones", async () => {
    const html = await renderRoot();
    expect(html).toContain("Alpha Session");
    expect(html).toContain("Beta Session");
    expect(html).not.toContain("Silent Run");
  });

  it("renders the table headers and session metadata", async () => {
    const html = await renderRoot();
    expect(html).toContain("Working Dir");
    expect(html).toContain("Updated");
    expect(html).toContain("Tokens");
    expect(html).toContain("Provider");
    expect(html).toContain("/tmp/alpha");
    expect(html).toContain("anthropic");
    expect(html).toContain("1,234");
  });

  it("shows an empty state when there are no sessions", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "glv-web-empty-"));
    const emptyDb = new DatabaseSync(join(emptyDir, "sessions.db"));
    emptyDb.exec(SCHEMA);
    try {
      const res = await createApp(emptyDb).request("/");
      expect(await res.text()).toContain("No sessions found.");
    } finally {
      emptyDb.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
