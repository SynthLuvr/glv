import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { defineTable, placeholders, transaction } from "../query";

const SESSION_TTL_SECONDS = 86400;

// Absolute ceiling on a session's lifespan. Without it a continuously
// refreshed session never expires, so a stolen cookie stays valid as long
// as it keeps seeing activity.
const SESSION_MAX_LIFETIME_SECONDS = 604800; // 7 days

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

const credentialShape = {
  id: "string",
  user_id: "string",
  public_key: "unknown",
  counter: "number",
  transports: "string | null",
} as const;

const CredentialRow = type(credentialShape);

type CredentialRow = typeof CredentialRow.infer;

const credentials = defineTable({
  table: "credentials",
  columns: Object.keys(credentialShape),
  schema: CredentialRow,
});

const users = defineTable({
  table: "users",
  columns: ["id"],
  schema: type({ id: "string" }),
});

const sessions = defineTable({
  table: "sessions",
  columns: ["id"],
  schema: type({ id: "string" }),
});

const mapCredential = (row: CredentialRow): StoredCredential => ({
  id: row.id,
  userId: row.user_id,
  publicKey: toUint8Array(row.public_key),
  counter: row.counter,
  transports: parseTransports(row.transports),
});

const userCount = (db: DatabaseSync): number => users.count(db);

const isClaimed = (db: DatabaseSync): boolean => userCount(db) > 0;

const listCredentials = (db: DatabaseSync): StoredCredential[] =>
  credentials.all(db).map(mapCredential);

const getCredential = (
  db: DatabaseSync,
  id: string,
): StoredCredential | undefined => {
  const row = credentials.one(db, { where: "id = ?", params: [id] });
  if (row === undefined) return undefined;
  return mapCredential(row);
};

const createOwner = (db: DatabaseSync, credential: NewCredential): string => {
  const userId = randomUUID();
  transaction(db, () => {
    users.insert(db, {
      columns: ["id", "username"],
      values: placeholders(2),
      params: [userId, "owner"],
    });
    credentials.insert(db, {
      columns: ["id", "user_id", "public_key", "counter", "transports"],
      values: placeholders(5),
      params: [
        credential.id,
        userId,
        credential.publicKey,
        credential.counter,
        JSON.stringify(credential.transports),
      ],
    });
  });
  return userId;
};

const updateCounter = (db: DatabaseSync, id: string, counter: number): void =>
  credentials.update(db, {
    set: "counter = ?",
    where: "id = ?",
    params: [counter, id],
  });

const newToken = (): string => randomBytes(32).toString("base64url");

// Sessions are only removed on explicit logout, so purge expired rows here
// to keep the table from growing without bound.
const purgeExpiredSessions = (db: DatabaseSync): void =>
  sessions.remove(db, { where: "expires_at <= datetime('now')" });

const createSession = (db: DatabaseSync, userId: string): string => {
  purgeExpiredSessions(db);
  const token = newToken();
  sessions.insert(db, {
    columns: ["id", "user_id", "expires_at"],
    values: "?, ?, datetime('now', '+1 day')",
    params: [token, userId],
  });
  return token;
};

const validSession = (db: DatabaseSync, token: string | undefined): boolean => {
  if (token === undefined || token === "") return false;
  return (
    sessions.count(db, {
      where:
        "id = ? AND expires_at > datetime('now') " +
        "AND datetime(created_at, ?) > datetime('now')",
      params: [token, `+${SESSION_MAX_LIFETIME_SECONDS} seconds`],
    }) > 0
  );
};

const refreshSession = (db: DatabaseSync, token: string): void =>
  sessions.update(db, {
    set: "expires_at = min(datetime('now', ?), datetime(created_at, ?))",
    where: "id = ?",
    params: [
      `+${SESSION_TTL_SECONDS} seconds`,
      `+${SESSION_MAX_LIFETIME_SECONDS} seconds`,
      token,
    ],
  });

const deleteSession = (db: DatabaseSync, token: string): void =>
  sessions.remove(db, { where: "id = ?", params: [token] });

export type { NewCredential };
export {
  createOwner,
  createSession,
  deleteSession,
  getCredential,
  isClaimed,
  listCredentials,
  openAuthDb,
  refreshSession,
  resolveAuthDbPath,
  SESSION_TTL_SECONDS,
  updateCounter,
  validSession,
};
