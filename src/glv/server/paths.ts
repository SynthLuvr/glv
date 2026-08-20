import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const listHomeDirs = (home: string = homedir()): string[] =>
  readdirSync(home, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(home, entry.name))
    .sort();

// The new-session form submits ~, which Node will not expand itself. Both
// separator spellings are accepted so a Windows "~\dir" expands the same as
// "~/dir".
const expandHome = (path: string, home: string = homedir()): string =>
  path === "~"
    ? home
    : path.startsWith("~/") || path.startsWith("~\\")
      ? join(home, path.slice(2))
      : path;

export { expandHome, listHomeDirs };
