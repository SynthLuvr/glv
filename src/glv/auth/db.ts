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

const resolveAuthDbPath = (dataDirName: string, override?: string): string =>
  resolveDataPath(override, "GLV_AUTH_DB", dataDirName, "auth.db");

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
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
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

// Lightweight projection for the "manage passkeys" screen — omits the public
// key blob and surfaces the creation time so each credential is identifiable.
type CredentialSummary = {
  id: string;
  transports: string[];
  createdAt: string;
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
  } catch (err) {
    console.warn("[glv:auth]", err);
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

const credentialSummaryShape = {
  id: "string",
  transports: "string | null",
  created_at: "string",
} as const;

const CredentialSummaryRow = type(credentialSummaryShape);

type CredentialSummaryRow = typeof CredentialSummaryRow.infer;

const mapCredentialSummary = (
  row: CredentialSummaryRow,
): CredentialSummary => ({
  id: row.id,
  transports: parseTransports(row.transports),
  createdAt: row.created_at,
});

const userCount = (db: DatabaseSync): number => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  return typeof row?.n === "number" ? row.n : 0;
};

const isClaimed = (db: DatabaseSync): boolean => userCount(db) > 0;

// Single-owner model: the first user is the permanent owner. Subsequent
// passkeys (e.g. for a different domain) attach to this same user.
const ownerUserId = (db: DatabaseSync): string | undefined => {
  const row = db
    .prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
    .get();
  return typeof row?.id === "string" ? row.id : undefined;
};

const listCredentials = (db: DatabaseSync): StoredCredential[] =>
  validateAll(
    CredentialRow,
    db.prepare(`SELECT ${CREDENTIAL_COLS} FROM credentials`).all(),
  ).map(mapCredential);

const listCredentialSummaries = (db: DatabaseSync): CredentialSummary[] =>
  validateAll(
    CredentialSummaryRow,
    db
      .prepare(
        "SELECT id, transports, created_at FROM credentials ORDER BY created_at DESC",
      )
      .all(),
  ).map(mapCredentialSummary);

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

// A passkey is origin-bound, so the owner accumulates one credential per
// domain/device; createOwner reuses this for the first credential.
const addCredential = (
  db: DatabaseSync,
  userId: string,
  credential: NewCredential,
): void => {
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
};

const createOwner = (db: DatabaseSync, credential: NewCredential): string => {
  const userId = randomUUID();
  transaction(db, () => {
    db.prepare("INSERT INTO users (id, username) VALUES (?, ?)").run(
      userId,
      "owner",
    );
    addCredential(db, userId, credential);
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

// Sessions are host-scoped, so a cookie on one origin can't authorize adding a
// passkey on another. The owner mints this single-use bearer token while
// authenticated, then redeems it on the other origin to run the ceremony.
const createEnrollmentToken = (
  db: DatabaseSync,
  userId: string,
  ttlSeconds: number,
): string => {
  const token = newToken();
  db.prepare(
    `INSERT INTO enrollment_tokens (id, user_id, expires_at)
       VALUES (?, ?, datetime('now', ?))`,
  ).run(token, userId, `+${ttlSeconds} seconds`);
  return token;
};

const enrollmentTokenValid = (db: DatabaseSync, token: string): boolean => {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM enrollment_tokens
         WHERE id = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    )
    .get(token);
  return typeof row?.n === "number" && row.n > 0;
};

// Atomically claims an unused, unexpired token so a shared link can't enroll
// twice. Returns the owning user id on success.
const consumeEnrollmentToken = (
  db: DatabaseSync,
  token: string,
): string | undefined => {
  const claim = db
    .prepare(
      `UPDATE enrollment_tokens SET used_at = datetime('now')
         WHERE id = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    )
    .run(token);
  if (claim.changes !== 1) return undefined;
  const row = db
    .prepare("SELECT user_id AS userId FROM enrollment_tokens WHERE id = ?")
    .get(token);
  return typeof row?.userId === "string" ? row.userId : undefined;
};

export type { CredentialSummary, NewCredential };
export {
  addCredential,
  consumeEnrollmentToken,
  createEnrollmentToken,
  createOwner,
  createSession,
  deleteSession,
  enrollmentTokenValid,
  getCredential,
  isClaimed,
  listCredentialSummaries,
  listCredentials,
  openAuthDb,
  ownerUserId,
  refreshSession,
  resolveAuthDbPath,
  SESSION_TTL_SECONDS,
  updateCounter,
  validSession,
};
