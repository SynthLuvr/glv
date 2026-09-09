import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb, resolveDataPath } from "./db-path.js";
import { JsonObject, parseJson } from "./parse.js";

// The config store: boot-time scalar settings (e.g. the forward host)
// in a glv-owned SQLite database beside the other stores, created on
// first use exactly like them. The hand-editable config.json that used
// to hold them is retired — serve imports whatever a legacy file still
// holds once, then renames it away (docs/decisions/0004).

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

// --- Legacy config-file bridge -------------------------------------
//
// Everything below reads the retired config.json one last time so an
// upgrade never loses a value, then retires the file. It exists only
// for that migration; new code must read the database.

const configRoot = (): string => {
  if (process.platform === "win32")
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

  return join(homedir(), ".config");
};

// The path the file always lived at (GLV_CONFIG honored so a file
// living elsewhere still migrates).
const resolveLegacyConfigPath = (dataDirName: string): string =>
  process.env.GLV_CONFIG ?? join(configRoot(), dataDirName, "config.json");

// The raw file, unknown keys included, or undefined when it is gone
// (the common case). Invalid JSON refuses the boot, leaving the file
// hand-fixable.
const readLegacyConfigFile = (
  dataDirName: string,
): Record<string, unknown> | undefined => {
  const path = resolveLegacyConfigPath(dataDirName);
  if (!existsSync(path)) return undefined;
  const parsed = parseJson(readFileSync(path, "utf-8"), JsonObject);
  if (!parsed.ok)
    throw new Error(`glv config at ${path} is not valid JSON: ${parsed.error}`);
  return parsed.data;
};

// Imports every non-cronJobs key from a legacy file's record — strings
// as-is, anything else the way `config list` always displayed it —
// then retires the file. The database wins on collision: keys the user
// already set through the new store are not overwritten by stale file
// values.
const importLegacyConfigValues = (
  db: DatabaseSync,
  raw: Record<string, unknown>,
  dataDirName: string,
): void => {
  const insert = db.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO NOTHING",
  );
  for (const [key, value] of Object.entries(raw)) {
    if (key === "cronJobs") continue;
    insert.run(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  retireLegacyConfigFile(dataDirName);
};

// Renames the file to config.json.bak — retired, but a copy stays
// behind instead of being destroyed. Any earlier backup is replaced.
const retireLegacyConfigFile = (dataDirName: string): void => {
  const path = resolveLegacyConfigPath(dataDirName);
  rmSync(`${path}.bak`, { force: true });
  renameSync(path, `${path}.bak`);
};

export {
  CONFIG_KEYS,
  importLegacyConfigValues,
  openConfigDb,
  readLegacyConfigFile,
  readRawConfig,
  resolveConfigDbPath,
  resolveForwardHost,
  writeConfigValue,
};
