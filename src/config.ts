import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import { tryParseJson } from "./parse.js";

// Lives outside the repo (never committed) so per-machine secrets like a
// forward host stay local to the system that owns them.
const Config = type({
  "forwardHost?": "string",
});

type GlvConfig = typeof Config.infer;

// Precedence mirrors the DB-path helpers: env override → XDG default.
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

export type { GlvConfig };
export { readConfig, resolveConfigPath };
