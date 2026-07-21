import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// All glv databases live under ~/.local/share. The precedence for picking a
// path is always the same: explicit override → environment variable → platform
// default — so every db module delegates here instead of repeating the ternary.
const resolveDataPath = (
  override: string | undefined,
  envVar: string,
  ...segments: string[]
): string =>
  override ??
  process.env[envVar] ??
  join(homedir(), ".local", "share", ...segments);

// Ensures the parent directory exists before a writable database is opened.
// The goose sessions DB is opened read-only and managed externally, so only
// the glv-owned databases (auth, prompts) call this.
const ensureDbDir = (dbPath: string): void => {
  mkdirSync(dirname(dbPath), { recursive: true });
};

export { ensureDbDir, resolveDataPath };
