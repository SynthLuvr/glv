import { CONFIG_KEYS, readRawConfig, writeConfig } from "../config.js";

const formatValue = (value: unknown): string => {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
};

const assertKnownKey = (key: string): void => {
  if (!CONFIG_KEYS.includes(key))
    throw new Error(
      `Unknown config key "${key}". Known keys: ${CONFIG_KEYS.join(", ")}`,
    );
};

const runConfigGet = (key: string): void => {
  assertKnownKey(key);
  const value = readRawConfig()[key];
  if (value !== undefined) console.log(formatValue(value));
};

const runConfigSet = (key: string, raw: string): void => {
  assertKnownKey(key);
  const config = readRawConfig();
  config[key] = raw;
  writeConfig(config);
  console.log(`${key}=${formatValue(config[key])}`);
};

const runConfigList = (): void => {
  const config = readRawConfig();
  const keys = [...new Set([...CONFIG_KEYS, ...Object.keys(config)])];
  for (const key of keys) console.log(`${key}=${formatValue(config[key])}`);
};

export { runConfigGet, runConfigList, runConfigSet };
