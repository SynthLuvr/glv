import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb, resolveDataPath } from "../db-path.js";

// Viewer-owned storage for suggested next prompts: one setting row
// (feature on/off, default off) and one suggestion row per session — the
// latest finished turn's prompts, keyed by a fingerprint of that turn so
// a row can never be mistaken for a later turn's suggestions. An empty
// prompts array means "asked, nothing usable came back" — the turn is
// still marked served, so the same finished turn is never asked twice,
// even across page refreshes or server restarts.

const SUGGESTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS suggestions (
  session_id TEXT PRIMARY KEY,
  turn_key   TEXT NOT NULL,
  prompts    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// The single setting key this store owns.
const ENABLED_KEY = "enabled";

// Writable by design: glv owns every table in here, so the schema is
// always created on open (safe to run before any suggestion was ever
// asked).
const openSuggestionsDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
  db.exec(SUGGESTIONS_SCHEMA);
  return db;
};

const resolveSuggestionsDbPath = (
  dataDirName: string,
  override?: string,
): string =>
  resolveDataPath(
    override,
    "GLV_SUGGESTIONS_DB",
    dataDirName,
    "suggestions.db",
  );

// The feature is opt-in: absent, malformed, or unknown values all read
// as off — a hand-edited row can only ever disable, never silently
// enable.
const suggestionsEnabled = (db: DatabaseSync): boolean => {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(ENABLED_KEY);
    if (typeof row !== "object" || row === null) return false;
    const { value } = row;
    return value === "1";
  } catch {
    return false;
  }
};

const setSuggestionsEnabled = (db: DatabaseSync, enabled: boolean): void => {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, " +
      "updated_at = datetime('now')",
  ).run(ENABLED_KEY, enabled ? "1" : "0");
};

// One stored suggestion set: the turn it answers (fingerprint) and the
// prompts parsed out of the assistant's reply. `prompts` is the JSON
// serialization of a (possibly empty) string array.
const StoredRow = type({ turn_key: "string", prompts: "string" });

type StoredRow = typeof StoredRow.infer;

// The stored prompts for a session, with the empty-array marker decoded
// back to "asked, nothing usable".
const readRow = (
  db: DatabaseSync,
  sessionId: string,
): { turnKey: string; prompts: string[] } | undefined => {
  let row: unknown;
  try {
    row = db
      .prepare("SELECT turn_key, prompts FROM suggestions WHERE session_id = ?")
      .get(sessionId);
  } catch {
    return undefined;
  }
  const valid = StoredRow(row);
  if (valid instanceof type.errors) return undefined;
  try {
    const parsed: unknown = JSON.parse(valid.prompts);
    if (!Array.isArray(parsed)) return undefined;
    return {
      turnKey: valid.turn_key,
      prompts: parsed.filter((p): p is string => typeof p === "string"),
    };
  } catch {
    return undefined;
  }
};

// Upserts the row for one session: the turn fingerprint plus the parsed
// prompts (empty = asked, nothing usable — still a served turn).
const putSuggestions = (
  db: DatabaseSync,
  sessionId: string,
  turnKey: string,
  prompts: readonly string[],
): void => {
  db.prepare(
    "INSERT INTO suggestions (session_id, turn_key, prompts) VALUES (?, ?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET " +
      "turn_key = excluded.turn_key, prompts = excluded.prompts, " +
      "created_at = datetime('now')",
  ).run(sessionId, turnKey, JSON.stringify(prompts));
};

// Drops every stored suggestion (not the setting) — used when a session
// is deleted so its row does not outlive it.
const forgetSession = (db: DatabaseSync, sessionId: string): void => {
  db.prepare("DELETE FROM suggestions WHERE session_id = ?").run(sessionId);
};

export type { StoredRow };
export {
  ENABLED_KEY,
  forgetSession,
  openSuggestionsDb,
  putSuggestions,
  readRow,
  resolveSuggestionsDbPath,
  setSuggestionsEnabled,
  suggestionsEnabled,
};
