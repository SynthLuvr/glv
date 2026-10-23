import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb, resolveDataPath } from "../db-path.js";
import { parseJson } from "../parse.js";
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
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const openAuthDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
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

// The transports column stores JSON.stringify of a string[]; anything
// else is corruption, surfaced as a warn and degraded to no transports
// rather than silently filtered to the string subset.
const TransportList = type("string[]");

const parseTransports = (raw: string | null): string[] => {
  if (raw === null) return [];
  const parsed = parseJson(raw, TransportList);
  if (!parsed.ok) {
    console.warn("[glv:auth]", parsed.error);
    return [];
  }
  return parsed.data;
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

// Existence checks are COUNT(*) queries; a positive count is a yes.
const rowExists = (
  db: DatabaseSync,
  sql: string,
  ...params: (string | number | null)[]
): boolean => {
  const row = db.prepare(sql).get(...params);
  return typeof row?.n === "number" && row.n > 0;
};

const isClaimed = (db: DatabaseSync): boolean =>
  rowExists(db, "SELECT COUNT(*) AS n FROM users");

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
       VALUES (?, ?, datetime('now', ?))`,
  ).run(token, userId, `+${SESSION_TTL_SECONDS} seconds`);
  return token;
};

const validSession = (db: DatabaseSync, token: string | undefined): boolean => {
  if (token === undefined || token === "") return false;
  return rowExists(
    db,
    `SELECT COUNT(*) AS n FROM sessions
       WHERE id = ? AND expires_at > datetime('now')
         AND datetime(created_at, ?) > datetime('now')`,
    token,
    `+${SESSION_MAX_LIFETIME_SECONDS} seconds`,
  );
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

const enrollmentTokenValid = (db: DatabaseSync, token: string): boolean =>
  rowExists(
    db,
    `SELECT COUNT(*) AS n FROM enrollment_tokens
       WHERE id = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    token,
  );

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

// API tokens are long-lived bearer credentials minted by the owner for
// non-browser clients (curl, CI). Unlike sessions, only the SHA-256 hash
// is stored — they live for weeks in CI configs — so the lookup is a
// primary-key hit on that hash and no token bytes are ever compared.
const API_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const API_TOKEN_PREFIX = "glv_at_";

const tokenHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

// All the management screen can show: the raw token is never stored, so
// it can never be listed.
type ApiTokenSummary = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
};

const ApiTokenSummaryRow = type({
  id: "string",
  name: "string",
  created_at: "string",
  "last_used_at?": "string | null",
  expires_at: "string",
});

type ApiTokenSummaryRow = typeof ApiTokenSummaryRow.infer;

const mapApiTokenSummary = (row: ApiTokenSummaryRow): ApiTokenSummary => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at ?? null,
  expiresAt: row.expires_at,
});

const listApiTokenSummaries = (db: DatabaseSync): ApiTokenSummary[] =>
  validateAll(
    ApiTokenSummaryRow,
    db
      .prepare(
        "SELECT id, name, created_at, last_used_at, expires_at " +
          "FROM api_tokens ORDER BY created_at DESC",
      )
      .all(),
  ).map(mapApiTokenSummary);

const createApiToken = (
  db: DatabaseSync,
  userId: string,
  name: string,
): string => {
  // Tokens are otherwise only removed on revoke, so purge expired rows
  // here to keep the table from growing without bound (as sessions do).
  db.prepare(
    "DELETE FROM api_tokens WHERE expires_at <= datetime('now')",
  ).run();
  const token = API_TOKEN_PREFIX + newToken();
  db.prepare(
    `INSERT INTO api_tokens (id, user_id, name, expires_at)
       VALUES (?, ?, ?, datetime('now', ?))`,
  ).run(tokenHash(token), userId, name, `+${API_TOKEN_TTL_SECONDS} seconds`);
  return token;
};

const apiTokenValid = (db: DatabaseSync, token: string): boolean =>
  rowExists(
    db,
    `SELECT COUNT(*) AS n FROM api_tokens
       WHERE id = ? AND expires_at > datetime('now')`,
    tokenHash(token),
  );

// Deliberately no sliding refresh: a token that silently lives forever is
// what the session max-lifetime ceiling exists to prevent. Fixed TTL plus
// a visible last_used_at is the revocability story instead.
const touchApiToken = (db: DatabaseSync, token: string): void => {
  db.prepare(
    "UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?",
  ).run(tokenHash(token));
};

// `id` is the stored token hash.
const revokeApiToken = (db: DatabaseSync, id: string): void => {
  db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id);
};

export type { ApiTokenSummary, CredentialSummary, NewCredential };
export {
  addCredential,
  apiTokenValid,
  consumeEnrollmentToken,
  createApiToken,
  createEnrollmentToken,
  createOwner,
  createSession,
  deleteSession,
  enrollmentTokenValid,
  getCredential,
  isClaimed,
  listApiTokenSummaries,
  listCredentialSummaries,
  listCredentials,
  openAuthDb,
  ownerUserId,
  refreshSession,
  resolveAuthDbPath,
  revokeApiToken,
  SESSION_TTL_SECONDS,
  touchApiToken,
  updateCounter,
  validSession,
};
