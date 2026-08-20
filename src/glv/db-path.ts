import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const dataRoot = (): string => {
  if (platform() === "win32")
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

  return join(homedir(), ".local", "share");
};

// Precedence: explicit override → environment variable → platform default.
// Callers pass their flavor's data directory name as the first segment so
// two glv builds installed on one machine never share SQLite files,
// uploads, or temp dirs. An empty value counts as unset: node:sqlite
// happily opens "" as a private temporary database, so data written there
// silently vanishes on restart.
const resolveDataPath = (
  override: string | undefined,
  envVar: string,
  ...segments: string[]
): string => {
  const value = override ?? process.env[envVar];
  if (value === undefined || value === "") return join(dataRoot(), ...segments);
  return value;
};

// Only glv-owned databases need this; agent-owned session data is opened
// read-only and managed externally.
const ensureDbDir = (dbPath: string): void => {
  mkdirSync(dirname(dbPath), { recursive: true });
};

export { ensureDbDir, resolveDataPath };
