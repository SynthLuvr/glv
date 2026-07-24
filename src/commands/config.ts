import { CONFIG_KEYS, readRawConfig, writeConfig } from "../config.js";

// CONFIG_KEYS is `as const` (a tuple); widen to a readonly string array so
// `.includes()` type-checks without a separate cast at each call site.
const KNOWN_KEYS: readonly string[] = CONFIG_KEYS;

const formatValue = (value: unknown): string => {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
};

const assertKnownKey = (key: string): void => {
  if (!KNOWN_KEYS.includes(key))
    throw new Error(
      `Unknown config key "${key}". Known keys: ${KNOWN_KEYS.join(", ")}`,
    );
};

// Prints the value for a known key, or nothing when it is unset (so empty
// output signals absence without a non-zero exit).
const runConfigGet = (key: string): void => {
  assertKnownKey(key);
  const value = readRawConfig()[key];
  if (value !== undefined) console.log(formatValue(value));
};

// Overwrites a single key, preserving every other field, then validates the
// whole object against the schema before writing it back to disk.
const runConfigSet = (key: string, raw: string): void => {
  assertKnownKey(key);
  const config = readRawConfig();
  config[key] = raw;
  writeConfig(config);
  console.log(`${key}=${formatValue(config[key])}`);
};

// Schema keys first (modelled), then any extra keys already in the file, so
// both known and forward-compatible fields are visible.
const runConfigList = (): void => {
  const config = readRawConfig();
  const keys = [...new Set([...KNOWN_KEYS, ...Object.keys(config)])];
  for (const key of keys) console.log(`${key}=${formatValue(config[key])}`);
};

export { runConfigGet, runConfigList, runConfigSet };
