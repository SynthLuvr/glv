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
  refreshSession,
  SESSION_TTL_SECONDS,
  updateCounter,
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

  it("starts unclaimed", () => {
    expect(isClaimed(db)).toBe(false);
  });

  it("creates all three tables", () => {
    const isNameRow = (v: unknown): v is { name: string } =>
      typeof v === "object" &&
      v !== null &&
      "name" in v &&
      typeof v.name === "string";
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .filter(isNameRow);
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

  it("is claimed after the owner credential is stored", () => {
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
    expect(isClaimed(db)).toBe(true);
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

  it("createSession opportunistically purges expired rows", () => {
    insertExpired("purge-on-login");
    expect(sessionExists("purge-on-login")).toBe(true);
    createSession(db, ownerId);
    expect(sessionExists("purge-on-login")).toBe(false);
  });
});

describe("session absolute max lifetime", () => {
  let db: DatabaseSync;
  let dir: string;
  let ownerId: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-auth-maxlife-"));
    db = openAuthDb(join(dir, "auth.db"));
    ownerId = createOwner(db, {
      id: "cred-maxlife",
      publicKey: new Uint8Array([5]),
      counter: 0,
      transports: [],
    });
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Sub-second precision tolerates wall-clock drift in assertions.
  const expirySecondsFromNow = (token: string): number => {
    const row = db
      .prepare(
        "SELECT CAST((julianday(expires_at) - julianday('now')) * 86400 " +
          "AS REAL) AS s FROM sessions WHERE id = ?",
      )
      .get(token);
    if (
      typeof row === "object" &&
      row !== null &&
      "s" in row &&
      typeof row.s === "number"
    )
      return row.s;
    return NaN;
  };

  // Compares two stored columns, so it is exact and clock-independent.
  const expiresAtAbsoluteCap = (token: string): boolean => {
    const row = db
      .prepare(
        "SELECT expires_at = datetime(created_at, ?) AS matches " +
          "FROM sessions WHERE id = ?",
      )
      // 7-day absolute cap mirrors SESSION_MAX_LIFETIME_SECONDS in auth/db.ts.
      .get("+604800 seconds", token) as { matches?: number } | undefined;
    return row?.matches === 1;
  };

  // expires_at is far in the future, so only created_at governs validity.
  const insertSession = (id: string, createdAtOffset: string): void => {
    db.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) " +
        "VALUES (?, ?, datetime('now', '+2 days'), datetime('now', ?))",
    ).run(id, ownerId, createdAtOffset);
  };

  it("rejects a session whose absolute lifetime has elapsed", () => {
    const token = "maxed-out-token";
    insertSession(token, "-8 days");
    expect(validSession(db, token)).toBe(false);
  });

  it("refreshSession extends a fresh session by the sliding window", () => {
    const token = createSession(db, ownerId);
    refreshSession(db, token);
    // The absolute cap (7 days out) is not yet binding, so the 1-day
    // sliding window governs.
    expect(validSession(db, token)).toBe(true);
    expect(expirySecondsFromNow(token)).toBeGreaterThan(
      SESSION_TTL_SECONDS - 10,
    );
    expect(expirySecondsFromNow(token)).toBeLessThanOrEqual(
      SESSION_TTL_SECONDS,
    );
  });

  it("refreshSession never extends a session past the absolute maximum", () => {
    const token = "capped-token";
    // 8 days old: created_at + max lifetime is already in the past, so a
    // refresh cannot keep the session alive.
    insertSession(token, "-8 days");
    refreshSession(db, token);
    expect(expiresAtAbsoluteCap(token)).toBe(true);
    expect(validSession(db, token)).toBe(false);
  });

  it("clamps to the absolute ceiling when it is closer than the sliding window", () => {
    const token = "near-cap-token";
    // ~6.5 days old: the cap (~0.5 days out) is sooner than the 1-day
    // sliding window, so the cap must win.
    insertSession(token, "-6.5 days");
    refreshSession(db, token);
    expect(expiresAtAbsoluteCap(token)).toBe(true);
    expect(validSession(db, token)).toBe(true);
    // ~0.5 days remaining rather than the full 1-day sliding window.
    expect(expirySecondsFromNow(token)).toBeGreaterThan(
      SESSION_TTL_SECONDS / 2 - 10,
    );
    expect(expirySecondsFromNow(token)).toBeLessThan(
      SESSION_TTL_SECONDS / 2 + 10,
    );
  });
});
