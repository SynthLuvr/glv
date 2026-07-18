import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOwner,
  createSession,
  deleteSession,
  getCredential,
  isClaimed,
  listCredentials,
  openAuthDb,
  purgeExpiredSessions,
  updateCounter,
  userCount,
  validSession,
} from "../auth/db.js";

describe("fresh auth database", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-auth-fresh-"));
    db = openAuthDb(join(dir, "auth.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts unclaimed with zero users", () => {
    expect(userCount(db)).toBe(0);
    expect(isClaimed(db)).toBe(false);
  });

  it("creates all three tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      "credentials",
      "sessions",
      "users",
    ]);
  });
});

describe("claimed auth database", () => {
  let db: DatabaseSync;
  let dir: string;
  let ownerId: string;

  const credential = {
    id: "cred-abc",
    publicKey: new Uint8Array([1, 2, 3, 4]),
    counter: 0,
    transports: ["internal", "hybrid"],
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-auth-claimed-"));
    db = openAuthDb(join(dir, "auth.db"));
    ownerId = createOwner(db, credential);
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("has exactly one user after claiming", () => {
    expect(userCount(db)).toBe(1);
    expect(isClaimed(db)).toBe(true);
  });

  it("retrieves the stored credential by id", () => {
    const cred = getCredential(db, "cred-abc");
    expect(cred).toBeDefined();
    expect(cred?.id).toBe("cred-abc");
    expect(cred?.userId).toBe(ownerId);
    expect(Array.from(cred?.publicKey ?? [])).toEqual([1, 2, 3, 4]);
    expect(cred?.counter).toBe(0);
    expect(cred?.transports).toEqual(["internal", "hybrid"]);
  });

  it("lists all registered credentials", () => {
    const creds = listCredentials(db);
    expect(creds).toHaveLength(1);
    expect(creds[0]?.id).toBe("cred-abc");
  });

  it("updates the credential signature counter", () => {
    updateCounter(db, "cred-abc", 7);
    expect(getCredential(db, "cred-abc")?.counter).toBe(7);
  });

  it("returns undefined for an unknown credential id", () => {
    expect(getCredential(db, "nonexistent")).toBeUndefined();
  });

  it("persists the database across reopens", () => {
    db.close();
    db = openAuthDb(join(dir, "auth.db"));
    expect(userCount(db)).toBe(1);
    expect(getCredential(db, "cred-abc")).toBeDefined();
  });
});

describe("session lifecycle", () => {
  let db: DatabaseSync;
  let dir: string;
  let ownerId: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-auth-session-"));
    db = openAuthDb(join(dir, "auth.db"));
    ownerId = createOwner(db, {
      id: "cred-sess",
      publicKey: new Uint8Array([9]),
      counter: 0,
      transports: [],
    });
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates and validates a fresh session", () => {
    const token = createSession(db, ownerId);
    expect(token).toBeTruthy();
    expect(validSession(db, token)).toBe(true);
  });

  it("rejects an empty or undefined token", () => {
    expect(validSession(db, "")).toBe(false);
    expect(validSession(db, undefined)).toBe(false);
  });

  it("rejects a token that does not exist", () => {
    expect(validSession(db, "totally-fake-token")).toBe(false);
  });

  it("rejects an expired session", () => {
    const expired = "expired-token";
    db.prepare(
      "INSERT INTO sessions (id, user_id, expires_at) " +
        "VALUES (?, ?, datetime('now', '-1 hour'))",
    ).run(expired, ownerId);
    expect(validSession(db, expired)).toBe(false);
  });

  it("deletes a session so it is no longer valid", () => {
    const token = createSession(db, ownerId);
    expect(validSession(db, token)).toBe(true);
    deleteSession(db, token);
    expect(validSession(db, token)).toBe(false);
  });
});

describe("expired session purging", () => {
  let db: DatabaseSync;
  let dir: string;
  let ownerId: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-auth-purge-"));
    db = openAuthDb(join(dir, "auth.db"));
    ownerId = createOwner(db, {
      id: "cred-purge",
      publicKey: new Uint8Array([7]),
      counter: 0,
      transports: [],
    });
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const insertExpired = (id: string): void => {
    db.prepare(
      "INSERT INTO sessions (id, user_id, expires_at) " +
        "VALUES (?, ?, datetime('now', '-1 hour'))",
    ).run(id, ownerId);
  };

  const sessionExists = (id: string): boolean =>
    db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id) !== undefined;

  const totalSessions = (): number => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
      n: number;
    };
    return row.n;
  };

  it("purgeExpiredSessions removes only expired rows", () => {
    const fresh = createSession(db, ownerId);
    insertExpired("purge-a");
    expect(sessionExists("purge-a")).toBe(true);
    purgeExpiredSessions(db);
    expect(sessionExists("purge-a")).toBe(false);
    expect(sessionExists(fresh)).toBe(true);
    expect(validSession(db, fresh)).toBe(true);
  });

  it("createSession opportunistically purges expired rows", () => {
    insertExpired("purge-on-login");
    expect(sessionExists("purge-on-login")).toBe(true);
    createSession(db, ownerId);
    expect(sessionExists("purge-on-login")).toBe(false);
  });

  it("is a no-op when nothing is expired", () => {
    const fresh = createSession(db, ownerId);
    const before = totalSessions();
    purgeExpiredSessions(db);
    expect(totalSessions()).toBe(before);
    expect(sessionExists(fresh)).toBe(true);
  });
});
