import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

// Platform-aware data root.  Unix follows XDG (~/.local/share); Windows uses
// %APPDATA% (AppData\Roaming), the conventional per-user application-data dir.
const dataRoot = (): string => {
  if (platform() === "win32")
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

  return join(homedir(), ".local", "share");
};

// Precedence: explicit override → environment variable → platform default.
const resolveDataPath = (
  override: string | undefined,
  envVar: string,
  ...segments: string[]
): string => override ?? process.env[envVar] ?? join(dataRoot(), ...segments);

// Only glv-owned databases (auth, prompts, groups) need this; the goose
// sessions DB is opened read-only and managed externally.
const ensureDbDir = (dbPath: string): void => {
  mkdirSync(dirname(dbPath), { recursive: true });
};

export { ensureDbDir, resolveDataPath };
