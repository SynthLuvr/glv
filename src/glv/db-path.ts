import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

// Opens a glv-owned database (agent-owned session data is opened
// read-only and managed externally, so it does not go through here).
// node:sqlite's default busy timeout is 0 (fail at once), so without
// this any transient lock on the file — a concurrent glv command, a
// scanner eyeing a fresh file — kills the open or the first statement
// with "database is locked" instead of waiting the lock out.
const openGlvDb = (dbPath: string): DatabaseSync => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  return db;
};

export { openGlvDb, resolveDataPath };
