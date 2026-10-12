import type { ModelSelection } from "../glv/models.js";
import type { EphemeralAsk } from "../glv/suggestions/ask.js";

// claude's behind-the-scenes ask. `--no-session-persistence` makes the
// run leave nothing behind — no transcript is written to the projects
// directory at all (verified empirically against claude 2.1.289: the
// only artifact is an empty per-directory folder, and glv lists
// transcript files only), so there is nothing to clean up afterwards.
//
// `manual` permission mode is deliberate: a headless --print run can
// never answer a permission prompt, so under "manual" any tool call the
// ask might attempt is denied outright — the ask can only ever answer
// with text, which is all it is asked to do.
const NO_PERSISTENCE_FLAGS = [
  "--print",
  "--no-session-persistence",
  "--permission-mode",
  "manual",
  "--output-format",
  "stream-json",
  "--verbose",
];

// An alias ("haiku") or a full model name; claude resolves it. No
// selection leaves claude's own precedence in charge.
const modelFlags = (model: ModelSelection | undefined): string[] =>
  model === undefined ? [] : ["--model", model.model];

const makeClaudeEphemeralAsk = (binary: string): EphemeralAsk => ({
  name: "claude",
  binary,
  args: (model) => [...NO_PERSISTENCE_FLAGS, ...modelFlags(model)],
  // Same reason as real runs: claude gates an unseen directory behind a
  // trust dialog a headless run can never answer.
  env: () => ({ CLAUDE_CODE_SANDBOXED: "1" }),
});

export { makeClaudeEphemeralAsk };
