import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read from a sibling markdown file so the prompt can be edited as prose
// without touching TypeScript. Resolved relative to this module so it's
// found regardless of the process working directory.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYSTEM_PROMPT = readFileSync(
  join(moduleDir, "system-prompt.md"),
  "utf-8",
).trimEnd();

export { DEFAULT_SYSTEM_PROMPT };
