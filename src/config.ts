import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";
import { tryParseJson } from "./parse.js";

const Config = type({
  "forwardHost?": "string",
});

type GlvConfig = typeof Config.infer;

// Known top-level keys the `glv config` command may read or write.
const CONFIG_KEYS = ["forwardHost"] as const;

// Lives outside the repo so per-machine secrets (e.g. a forward host) stay
// uncommitted. Precedence mirrors the DB-path helpers: env override → default.
const resolveConfigPath = (): string =>
  process.env.GLV_CONFIG ?? join(homedir(), ".config", "glv", "config.json");

const readConfig = (): GlvConfig => {
  const path = resolveConfigPath();
  if (!existsSync(path)) return {};
  const parsed = tryParseJson(readFileSync(path, "utf-8"));
  if (parsed === null || typeof parsed !== "object")
    throw new Error(`glv config at ${path} is not a valid JSON object`);
  const result = Config(parsed);
  if (result instanceof type.errors)
    throw new Error(`invalid glv config: ${result.summary}`);
  return result;
};

// Read the raw config object, preserving unknown keys, so writeConfig can
// round-trip fields the schema does not yet model.
const readRawConfig = (): Record<string, unknown> => {
  const path = resolveConfigPath();
  if (!existsSync(path)) return {};
  const parsed = tryParseJson(readFileSync(path, "utf-8"));
  if (parsed === null || typeof parsed !== "object")
    throw new Error(`glv config at ${path} is not a valid JSON object`);
  return parsed as Record<string, unknown>;
};

// Validate against the schema then persist, creating the parent directory so
// the first `glv config set` does not fail on a missing ~/.config/glv.
const writeConfig = (config: Record<string, unknown>): void => {
  const result = Config(config);
  if (result instanceof type.errors)
    throw new Error(`invalid glv config: ${result.summary}`);
  const path = resolveConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
};

export type { GlvConfig };
export {
  CONFIG_KEYS,
  readConfig,
  readRawConfig,
  resolveConfigPath,
  writeConfig,
};
