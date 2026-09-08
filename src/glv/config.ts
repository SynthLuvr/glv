import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";
import { JsonObject, parseJson } from "./parse.js";

const configRoot = (): string => {
  if (platform() === "win32")
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

  return join(homedir(), ".config");
};

// The config file holds boot-time scalar settings (e.g. a forward
// host). It lives outside the repo so per-machine secrets stay
// uncommitted, and is read once at startup — everything mutable
// (sessions' rename/archive meta, prompts, groups, cron jobs, cron
// session tags) lives in glv-owned SQLite databases instead (scheduled
// runs in the cron database — see cron-jobs.ts).
const Config = type({
  "forwardHost?": "string",
});

type GlvConfig = typeof Config.infer;

const CONFIG_KEYS: readonly string[] = ["forwardHost"];

// Precedence mirrors the DB-path helpers: env override → default.
const resolveConfigPath = (dataDirName: string): string =>
  process.env.GLV_CONFIG ?? join(configRoot(), dataDirName, "config.json");

// The raw file, unknown keys included — what list/set preserve on disk.
const readRawConfig = (dataDirName: string): Record<string, unknown> => {
  const path = resolveConfigPath(dataDirName);
  if (!existsSync(path)) return {};
  const parsed = parseJson(readFileSync(path, "utf-8"), JsonObject);
  if (!parsed.ok)
    throw new Error(`glv config at ${path} is not valid JSON: ${parsed.error}`);
  return parsed.data;
};

const validateConfig = (config: Record<string, unknown>): GlvConfig => {
  const result = Config(config);
  if (result instanceof type.errors)
    throw new Error(`invalid glv config: ${result.summary}`);
  return result;
};

const readConfig = (dataDirName: string): GlvConfig =>
  validateConfig(readRawConfig(dataDirName));

// Writes the raw record (unknown keys preserved) after validating the
// known ones, so a bad value can never reach the file.
const writeConfig = (
  dataDirName: string,
  config: Record<string, unknown>,
): void => {
  validateConfig(config);
  const path = resolveConfigPath(dataDirName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
};

export {
  CONFIG_KEYS,
  readConfig,
  readRawConfig,
  resolveConfigPath,
  writeConfig,
};
