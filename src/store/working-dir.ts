import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code stores each session transcript under the "projects" directory
// of its config root, in a directory named after the session's working
// directory with every path separator, dot, and underscore replaced by a
// dash — verified empirically against claude 2.1.232:
// /tmp/glv-enc.a_b/x → -tmp-glv-enc-a-b-x.
const encodeWorkingDir = (workingDir: string): string =>
  workingDir
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll(".", "-")
    .replaceAll("_", "-");

// Precedence mirrors the other data paths: explicit override → environment
// variable (CLAUDE_CONFIG_DIR, the same one the claude CLI honours, so glv
// and claude always agree on where transcripts live) → platform default
// (~/.claude).
const resolveProjectsRoot = (override?: string): string =>
  override ??
  (process.env.CLAUDE_CONFIG_DIR !== undefined &&
  process.env.CLAUDE_CONFIG_DIR !== ""
    ? join(process.env.CLAUDE_CONFIG_DIR, "projects")
    : join(homedir(), ".claude", "projects"));

export { encodeWorkingDir, resolveProjectsRoot };
