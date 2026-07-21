import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Precedence: explicit override → environment variable → ~/.local/share default.
const resolveDataPath = (
  override: string | undefined,
  envVar: string,
  ...segments: string[]
): string =>
  override ??
  process.env[envVar] ??
  join(homedir(), ".local", "share", ...segments);

// Only glv-owned databases (auth, prompts) need this; the goose sessions DB
// is opened read-only and managed externally.
const ensureDbDir = (dbPath: string): void => {
  mkdirSync(dirname(dbPath), { recursive: true });
};

export { ensureDbDir, resolveDataPath };
