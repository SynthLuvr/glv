import { type DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb, resolveDataPath } from "./db-path.js";

// The config store: boot-time scalar settings (e.g. the forward host)
// in a glv-owned SQLite database beside the other stores, created on
// first use exactly like them. The hand-editable config.json that used
// to hold them is retired and never read (docs/decisions/0004).

const CONFIG_KEYS: readonly string[] = ["forwardHost"];

const CONFIG_SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Precedence mirrors every other glv-owned store: flag → env →
// platform default under the flavor's data directory.
const resolveConfigDbPath = (dataDirName: string, override?: string): string =>
  resolveDataPath(override, "GLV_CONFIG_DB", dataDirName, "config.db");

// Writable by design: glv owns the whole file and creates the schema on
// open, exactly like the cron, prompts, and groups stores.
const openConfigDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
  db.exec(CONFIG_SCHEMA);
  return db;
};

// Everything in the table, unknown keys included — what `config list`
// prints. node:sqlite widens; a drifted row shape is dropped, not
// trusted.
const ConfigRow = type({ key: "string", value: "string" });

const readRawConfig = (db: DatabaseSync): Record<string, string> => {
  const config: Record<string, string> = {};
  for (const row of db.prepare("SELECT key, value FROM config").all()) {
    const valid = ConfigRow(row);
    if (!(valid instanceof type.errors)) config[valid.key] = valid.value;
  }
  return config;
};

// Upserts one key. Values are TEXT — the CLI always passes strings —
// so there is nothing to validate beyond the caller's key check.
const writeConfigValue = (db: DatabaseSync, key: string, value: string) =>
  db
    .prepare(
      "INSERT INTO config (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET " +
        "value = excluded.value, updated_at = datetime('now')",
    )
    .run(key, value);

// Resolved by serve --forward, from the database only.
const resolveForwardHost = (db: DatabaseSync, profileId: string): string => {
  const { forwardHost } = readRawConfig(db);
  if (forwardHost !== undefined) return forwardHost;
  throw new Error(
    `--forward needs "forwardHost" set — run: ` +
      `glv-${profileId} config set forwardHost <host>`,
  );
};

export {
  CONFIG_KEYS,
  openConfigDb,
  readRawConfig,
  resolveConfigDbPath,
  resolveForwardHost,
  writeConfigValue,
};
