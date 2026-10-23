import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb, resolveDataPath } from "../db-path.js";

// Viewer-owned storage for suggested next prompts: one setting row
// (the pinned ask model) and one suggestion row per session — the
// latest finished turn's prompts, keyed by a fingerprint of that turn
// so a row can never be mistaken for a later turn's suggestions.
// An empty prompts array means "asked, nothing usable came back" — the
// turn is still marked served, so it is never asked twice, even across
// page refreshes or server restarts.

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
const MODEL_KEY = "model";

// glv owns every table here, so the schema is always safe to create on
// open, before any suggestion was ever asked.
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

// Every read failure (missing row, missing table, malformed value) reads
// as undefined, so a hand-edited database degrades to the default rather
// than crashing the server.
const readSetting = (db: DatabaseSync, key: string): string | undefined => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (typeof row !== "object" || row === null) return undefined;
    const { value } = row;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
};

// The pinned model for suggestion asks, in the combined picker spelling
// ("<agent>:<model value>", e.g. "claude:claude:haiku"); undefined when
// unset or blank, so every agent answers on its own default. Read fresh
// per ask — an edit to the row applies without a restart.
const getSuggestionModel = (db: DatabaseSync): string | undefined => {
  const value = readSetting(db, MODEL_KEY)?.trim();
  return value === undefined || value === "" ? undefined : value;
};

// One stored suggestion set: the turn it answers (fingerprint) and the
// JSON-serialized prompts (a possibly empty string array).
const StoredRow = type({ turn_key: "string", prompts: "string" });

const parsePrompts = (json: string): string[] | undefined => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return undefined;
  }
};

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
  const prompts = parsePrompts(valid.prompts);
  return prompts === undefined
    ? undefined
    : { turnKey: valid.turn_key, prompts };
};

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

export {
  forgetSession,
  getSuggestionModel,
  openSuggestionsDb,
  putSuggestions,
  readRow,
  resolveSuggestionsDbPath,
};
