import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSession, renameSession } from "../db.js";

const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  user_set_name BOOLEAN DEFAULT FALSE,
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_tokens INTEGER,
  provider_name TEXT,
  archived_at TIMESTAMP
);
`;

let dir = "";
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glv-rename-"));
  db = new DatabaseSync(join(dir, "sessions.db"));
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO sessions (id, name, user_set_name, session_type, " +
      "working_dir) VALUES (?, ?, ?, ?, ?)",
  ).run("s1", "Auto Name", 0, "user", "/tmp");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("renameSession", () => {
  it("sets a custom name and marks it user-set", () => {
    renameSession(db, "s1", "My Custom");
    const row = getSession(db, "s1");
    expect(row?.name).toBe("My Custom");
    expect(row?.user_set_name).toBe(1);
  });

  it("trims surrounding whitespace", () => {
    renameSession(db, "s1", "  spaced  ");
    const row = getSession(db, "s1");
    expect(row?.name).toBe("spaced");
    expect(row?.user_set_name).toBe(1);
  });

  it("clears the custom name when given a blank value", () => {
    renameSession(db, "s1", "Temp");
    renameSession(db, "s1", "   ");
    const row = getSession(db, "s1");
    expect(row?.name).toBe("");
    expect(row?.user_set_name).toBe(0);
  });

  it("is a safe no-op for an unknown session id", () => {
    renameSession(db, "missing", "Nope");
    expect(getSession(db, "missing")).toBeUndefined();
    // the existing session is untouched
    expect(getSession(db, "s1")?.name).toBe("Auto Name");
  });
});
