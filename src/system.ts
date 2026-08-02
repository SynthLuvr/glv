import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Loaded from a sibling markdown file so the prompt text can be edited as
// prose without touching TypeScript. Resolved from this module's own URL so
// it works whether glv runs from source (bin/glv → tsx src/cli.ts) or under
// the test runner. trimEnd drops pandoc's trailing newline.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYSTEM_PROMPT = readFileSync(
  join(moduleDir, "system-prompt.md"),
  "utf-8",
).trimEnd();

export { DEFAULT_SYSTEM_PROMPT };
