import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { ensureDbDir, resolveDataPath } from "../db-path.js";
import { placeholders, transaction, validate, validateAll } from "../query.js";

const SESSION_TTL_SECONDS = 86400;

// Absolute ceiling on a session's lifespan. Without it a continuously
// refreshed session never expires, so a stolen cookie stays valid as long
// as it keeps seeing activity.
const SESSION_MAX_LIFETIME_SECONDS = 604800; // 7 days

const resolveAuthDbPath = (override?: string): string =>
  resolveDataPath(override, "GLV_AUTH_DB", "glv", "auth.db");

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
  ensureDbDir(dbPath);
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

const CREDENTIAL_COLS = Object.keys(credentialShape).join(", ");

const mapCredential = (row: CredentialRow): StoredCredential => ({
  id: row.id,
  userId: row.user_id,
  publicKey: toUint8Array(row.public_key),
  counter: row.counter,
  transports: parseTransports(row.transports),
});

const userCount = (db: DatabaseSync): number => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  return typeof row?.n === "number" ? row.n : 0;
};

const isClaimed = (db: DatabaseSync): boolean => userCount(db) > 0;

const listCredentials = (db: DatabaseSync): StoredCredential[] =>
  validateAll(
    CredentialRow,
    db.prepare(`SELECT ${CREDENTIAL_COLS} FROM credentials`).all(),
  ).map(mapCredential);

const getCredential = (
  db: DatabaseSync,
  id: string,
): StoredCredential | undefined => {
  const row = validate(
    CredentialRow,
    db
      .prepare(`SELECT ${CREDENTIAL_COLS} FROM credentials WHERE id = ?`)
      .get(id),
  );
  return row === undefined ? undefined : mapCredential(row);
};

const createOwner = (db: DatabaseSync, credential: NewCredential): string => {
  const userId = randomUUID();
  transaction(db, () => {
    db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(
      userId,
      "owner",
    );
    db.prepare(
      `INSERT INTO credentials
         (id, user_id, public_key, counter, transports)
         VALUES (${placeholders(5)})`,
    ).run(
      credential.id,
      userId,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports),
    );
  });
  return userId;
};

const updateCounter = (db: DatabaseSync, id: string, counter: number): void => {
  db.prepare("UPDATE credentials SET counter = ? WHERE id = ?").run(
    counter,
    id,
  );
};

const newToken = (): string => randomBytes(32).toString("base64url");

// Sessions are only removed on explicit logout, so purge expired rows here
// to keep the table from growing without bound.
const purgeExpiredSessions = (db: DatabaseSync): void => {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
};

const createSession = (db: DatabaseSync, userId: string): string => {
  purgeExpiredSessions(db);
  const token = newToken();
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at)
       VALUES (?, ?, datetime('now', '+1 day'))`,
  ).run(token, userId);
  return token;
};

const validSession = (db: DatabaseSync, token: string | undefined): boolean => {
  if (token === undefined || token === "") return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions
         WHERE id = ? AND expires_at > datetime('now')
           AND datetime(created_at, ?) > datetime('now')`,
    )
    .get(token, `+${SESSION_MAX_LIFETIME_SECONDS} seconds`);
  return typeof row?.n === "number" && row.n > 0;
};

const refreshSession = (db: DatabaseSync, token: string): void => {
  db.prepare(
    `UPDATE sessions
       SET expires_at = min(datetime('now', ?), datetime(created_at, ?))
       WHERE id = ?`,
  ).run(
    `+${SESSION_TTL_SECONDS} seconds`,
    `+${SESSION_MAX_LIFETIME_SECONDS} seconds`,
    token,
  );
};

const deleteSession = (db: DatabaseSync, token: string): void => {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(token);
};

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
