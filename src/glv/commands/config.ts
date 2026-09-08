import type { DatabaseSync } from "node:sqlite";
import {
  CONFIG_KEYS,
  openConfigDb,
  readRawConfig,
  resolveConfigDbPath,
  writeConfigValue,
} from "../config.js";

// One handle per invocation, like every other store-touching command:
// open, operate, close. openConfigDb creates the file on first use, so
// `config set` on a fresh install simply brings the database into
// being.
const withConfigDb = (dataDirName: string, fn: (db: DatabaseSync) => void) => {
  const db = openConfigDb(resolveConfigDbPath(dataDirName));
  try {
    fn(db);
  } finally {
    db.close();
  }
};

const assertKnownKey = (key: string): void => {
  if (!CONFIG_KEYS.includes(key))
    throw new Error(
      `Unknown config key "${key}". Known keys: ${CONFIG_KEYS.join(", ")}`,
    );
};

const runConfigGet = (dataDirName: string, key: string): void => {
  assertKnownKey(key);
  withConfigDb(dataDirName, (db) => {
    const value = readRawConfig(db)[key];
    if (value !== undefined) console.log(value);
  });
};

const runConfigSet = (
  dataDirName: string,
  key: string,
  value: string,
): void => {
  assertKnownKey(key);
  withConfigDb(dataDirName, (db) => {
    writeConfigValue(db, key, value);
    console.log(`${key}=${value}`);
  });
};

const runConfigList = (dataDirName: string): void => {
  withConfigDb(dataDirName, (db) => {
    const config = readRawConfig(db);
    const keys = [...new Set([...CONFIG_KEYS, ...Object.keys(config)])];
    for (const key of keys) console.log(`${key}=${config[key] ?? ""}`);
  });
};

export { runConfigGet, runConfigList, runConfigSet };
