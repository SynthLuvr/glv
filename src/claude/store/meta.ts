import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { DATA_DIR_NAME, ensureDbDir, resolveDataPath } from "../db-path.js";

// Viewer-owned sidecar for rename/archive metadata. Claude transcripts are
// append-only JSONL written by the claude CLI itself, so there is no
// writable sessions table to record viewer state in; it lives here instead,
// keyed by claude session id.
const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_meta (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  user_set_name INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT
);
`;

const MetaRow = type({
  id: "string",
  name: "string",
  user_set_name: "number",
  archived_at: "string | null",
});

type MetaRow = typeof MetaRow.infer;

const resolveMetaDbPath = (override?: string): string =>
  resolveDataPath(override, "GLV_META_DB", DATA_DIR_NAME, "meta.db");

// Writable by design: glv owns every table in here, so it always creates
// the schema on open (safe to run before claude has ever written anything).
const openMetaDb = (dbPath: string): DatabaseSync => {
  ensureDbDir(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(META_SCHEMA);
  return db;
};

const validate = (row: unknown): MetaRow | undefined => {
  const result = MetaRow(row);
  return result instanceof type.errors ? undefined : result;
};

const getMeta = (db: DatabaseSync, id: string): MetaRow | undefined =>
  validate(
    db
      .prepare(
        "SELECT id, name, user_set_name, archived_at FROM session_meta " +
          "WHERE id = ?",
      )
      .get(id),
  );

const listMeta = (db: DatabaseSync): Map<string, MetaRow> =>
  new Map(
    db
      .prepare("SELECT id, name, user_set_name, archived_at FROM session_meta")
      .all()
      .map((row) => validate(row))
      .filter((row): row is MetaRow => row !== undefined)
      .map((row) => [row.id, row]),
  );

// Archiving never deletes anything — claude still owns the transcript file.
const archiveSessions = (db: DatabaseSync, ids: string[]): void => {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO session_meta (id, archived_at) VALUES (?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT (id) DO UPDATE SET archived_at = excluded.archived_at",
  );
  for (const id of ids) stmt.run(id);
};

// A blank name clears the user-set flag so derived naming takes over again.
const renameSession = (db: DatabaseSync, id: string, rawName: string): void => {
  const name = rawName.trim();
  db.prepare(
    "INSERT INTO session_meta (id, name, user_set_name) VALUES (?, ?, ?) " +
      "ON CONFLICT (id) DO UPDATE " +
      "SET name = excluded.name, user_set_name = excluded.user_set_name",
  ).run(id, name, name === "" ? 0 : 1);
};

export type { MetaRow };
export {
  archiveSessions,
  getMeta,
  listMeta,
  openMetaDb,
  renameSession,
  resolveMetaDbPath,
};
