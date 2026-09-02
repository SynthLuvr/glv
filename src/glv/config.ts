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

// One scheduled run. Hand-edited for now — the file is the interface;
// glv/cron.ts validates and runs them when serve starts.
const CronJob = type({
  "name?": "string",
  schedule: "string>0",
  prompt: "string>0",
  workingDir: "string>0",
  "timezone?": "string",
  "enabled?": "boolean",
});

const Config = type({
  "forwardHost?": "string",
  "cronJobs?": type([CronJob, "[]"]),
});

type GlvConfig = typeof Config.infer;
type CronJobConfig = typeof CronJob.infer;

const CONFIG_KEYS: readonly string[] = ["forwardHost", "cronJobs"];

// Lives outside the repo so per-machine secrets (e.g. a forward host) stay
// uncommitted. Precedence mirrors the DB-path helpers: env override → default.
const resolveConfigPath = (dataDirName: string): string =>
  process.env.GLV_CONFIG ?? join(configRoot(), dataDirName, "config.json");

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

const writeConfig = (
  dataDirName: string,
  config: Record<string, unknown>,
): void => {
  validateConfig(config);
  const path = resolveConfigPath(dataDirName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
};

export type { CronJobConfig };
export { CONFIG_KEYS, readConfig, readRawConfig, writeConfig };
