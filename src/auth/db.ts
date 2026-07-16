import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SESSION_TTL_SECONDS = 86400;

const defaultAuthDbPath = (): string =>
  join(homedir(), ".local", "share", "glv", "auth.db");

const resolveAuthDbPath = (override?: string): string =>
  override ?? process.env.GLV_AUTH_DB ?? defaultAuthDbPath();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL DEFAULT 'owner',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS credentials (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  public_key  BLOB NOT NULL,
  counter     INTEGER NOT NULL,
  transports  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const openAuthDb = (dbPath: string): DatabaseSync => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
};

type StoredCredential = {
  id: string;
  userId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
};

type NewCredential = {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
};

const toUint8Array = (value: unknown): Uint8Array<ArrayBuffer> => {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("unexpected public key storage type");
};

const parseTransports = (raw: string | null): string[] => {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
};

const mapCredential = (row: {
  id: string;
  user_id: string;
  public_key: unknown;
  counter: number;
  transports: string | null;
}): StoredCredential => ({
  id: row.id,
  userId: row.user_id,
  publicKey: toUint8Array(row.public_key),
  counter: row.counter,
  transports: parseTransports(row.transports),
});

const userCount = (db: DatabaseSync): number => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  };
  return row.n;
};

const isClaimed = (db: DatabaseSync): boolean => userCount(db) > 0;

const listCredentials = (db: DatabaseSync): StoredCredential[] => {
  const rows = db
    .prepare(
      "SELECT id, user_id, public_key, counter, transports " +
        "FROM credentials",
    )
    .all() as Array<{
    id: string;
    user_id: string;
    public_key: unknown;
    counter: number;
    transports: string | null;
  }>;
  return rows.map(mapCredential);
};

const getCredential = (
  db: DatabaseSync,
  id: string,
): StoredCredential | undefined => {
  const row = db
    .prepare(
      "SELECT id, user_id, public_key, counter, transports " +
        "FROM credentials WHERE id = ?",
    )
    .get(id) as
    | {
        id: string;
        user_id: string;
        public_key: unknown;
        counter: number;
        transports: string | null;
      }
    | undefined;
  return row === undefined ? undefined : mapCredential(row);
};

const createOwner = (db: DatabaseSync, credential: NewCredential): string => {
  const userId = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO users (id, username) VALUES (?, 'owner')").run(
      userId,
    );
    db.prepare(
      "INSERT INTO credentials " +
        "(id, user_id, public_key, counter, transports) " +
        "VALUES (?, ?, ?, ?, ?)",
    ).run(
      credential.id,
      userId,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return userId;
};

const updateCounter = (db: DatabaseSync, id: string, counter: number): void => {
  db.prepare("UPDATE credentials SET counter = ? WHERE id = ?").run(
    counter,
    id,
  );
};

const newToken = (): string => randomBytes(32).toString("base64url");

const createSession = (db: DatabaseSync, userId: string): string => {
  const token = newToken();
  db.prepare(
    "INSERT INTO sessions (id, user_id, expires_at) " +
      "VALUES (?, ?, datetime('now', '+1 day'))",
  ).run(token, userId);
  return token;
};

const validSession = (db: DatabaseSync, token: string | undefined): boolean => {
  if (token === undefined || token === "") return false;
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sessions " +
        "WHERE id = ? AND expires_at > datetime('now')",
    )
    .get(token) as { ok: number } | undefined;
  return row !== undefined;
};

const refreshSession = (db: DatabaseSync, token: string): void => {
  db.prepare(
    "UPDATE sessions SET expires_at = datetime('now', '+1 day') WHERE id = ?",
  ).run(token);
};

const deleteSession = (db: DatabaseSync, token: string): void => {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(token);
};

const purgeExpiredSessions = (db: DatabaseSync): number => {
  const result = db
    .prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
    .run();
  return Number(result.changes);
};

export type { NewCredential, StoredCredential };
export {
  createOwner,
  createSession,
  deleteSession,
  getCredential,
  isClaimed,
  listCredentials,
  openAuthDb,
  purgeExpiredSessions,
  refreshSession,
  resolveAuthDbPath,
  SESSION_TTL_SECONDS,
  updateCounter,
  userCount,
  validSession,
};
