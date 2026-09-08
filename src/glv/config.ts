import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb, resolveDataPath } from "./db-path.js";
import { JsonObject, parseJson } from "./parse.js";
import type { FlavorProfile } from "./profile.js";

// The config store. Boot-time scalar settings (e.g. a forward host)
// live in a glv-owned SQLite database beside the other stores, created
// on first use exactly like them. The hand-editable config.json that
// used to hold them is retired: serve imports whatever a legacy file
// still holds once (migrateConfigValues, plus the cron-jobs import in
// serve.ts), then renames it away — see docs/decisions/0004.

const Config = type({
  "forwardHost?": "string",
});

type GlvConfig = typeof Config.infer;

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

const readConfig = (db: DatabaseSync): GlvConfig => {
  const result = Config(readRawConfig(db));
  if (result instanceof type.errors)
    throw new Error(`invalid glv config: ${result.summary}`);
  return result;
};

// Upserts one key. Values are TEXT — the CLI always passes strings —
// so there is nothing to validate beyond the caller's key check.
const writeConfigValue = (db: DatabaseSync, key: string, value: string) =>
  db
    .prepare(
      `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);

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

// The path the file always lived at (GLV_CONFIG override honored so a
// file living elsewhere still migrates).
const resolveLegacyConfigPath = (dataDirName: string): string =>
  process.env.GLV_CONFIG ?? join(configRoot(), dataDirName, "config.json");

// The raw file, unknown keys included, or undefined when it is gone
// (the common case). Invalid JSON refuses the boot with the message the
// config reader always used, leaving the file hand-fixable.
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

// How a legacy value lands in the TEXT column: strings as-is, anything
// else the way `config list` always displayed it.
const stringValue = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

// Imports every non-cronJobs key from a legacy file's record into the
// database, then retires the file (renamed to config.json.bak, so a
// copy stays behind instead of the value being destroyed). The
// database wins on collision: keys the user already set through the
// new store are not overwritten by stale file values.
const migrateConfigValues = (
  db: DatabaseSync,
  raw: Record<string, unknown>,
  dataDirName: string,
): void => {
  for (const [key, value] of Object.entries(raw)) {
    if (key === "cronJobs") continue;
    db.prepare(
      "INSERT INTO config (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO NOTHING",
    ).run(key, stringValue(value));
  }
  const path = resolveLegacyConfigPath(dataDirName);
  rmSync(`${path}.bak`, { force: true });
  renameSync(path, `${path}.bak`);
};

// serve --forward resolves the host from the database only — after the
// legacy import above has run, so a first boot whose forwardHost still
// lives in a file finds it there anyway.
const resolveForwardHost = (
  db: DatabaseSync,
  profile: FlavorProfile,
): string => {
  const { forwardHost } = readConfig(db);
  if (forwardHost !== undefined) return forwardHost;
  throw new Error(
    `--forward needs "forwardHost" set — run: ` +
      `glv-${profile.id} config set forwardHost <host>`,
  );
};

export {
  CONFIG_KEYS,
  migrateConfigValues,
  openConfigDb,
  readConfig,
  readLegacyConfigFile,
  readRawConfig,
  resolveConfigDbPath,
  resolveForwardHost,
  writeConfigValue,
};
