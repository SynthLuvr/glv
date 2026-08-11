import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";
import { tryParseJson } from "./parse.js";

// Platform-aware config root.  Unix follows XDG (~/.config); Windows uses
// %LOCALAPPDATA% (AppData\Local), the conventional per-user settings dir.
const configRoot = (): string => {
  if (platform() === "win32")
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

  return join(homedir(), ".config");
};

const Config = type({
  "forwardHost?": "string",
});

type GlvConfig = typeof Config.infer;

const CONFIG_KEYS: readonly string[] = ["forwardHost"];

// Lives outside the repo so per-machine secrets (e.g. a forward host) stay
// uncommitted. Precedence mirrors the DB-path helpers: env override → default.
const resolveConfigPath = (): string =>
  process.env.GLV_CONFIG ?? join(configRoot(), "glv", "config.json");

const readRawConfig = (): Record<string, unknown> => {
  const path = resolveConfigPath();
  if (!existsSync(path)) return {};
  const parsed = tryParseJson(readFileSync(path, "utf-8"));
  if (parsed === null || typeof parsed !== "object")
    throw new Error(`glv config at ${path} is not a valid JSON object`);
  return parsed as Record<string, unknown>;
};

const validateConfig = (config: Record<string, unknown>): GlvConfig => {
  const result = Config(config);
  if (result instanceof type.errors)
    throw new Error(`invalid glv config: ${result.summary}`);
  return result;
};

const readConfig = (): GlvConfig => validateConfig(readRawConfig());

const writeConfig = (config: Record<string, unknown>): void => {
  validateConfig(config);
  const path = resolveConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
};

export { CONFIG_KEYS, readConfig, readRawConfig, writeConfig };
