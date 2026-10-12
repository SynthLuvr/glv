import type { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "../glv/models.js";
import type { EphemeralAsk } from "../glv/suggestions/ask.js";
import { deleteSessionsInDir } from "./db.js";

// goose's behind-the-scenes ask. `run --no-session` keeps the run off
// the books — no session in the sidebar, no transcript to clean up — but
// it still writes a hidden session row into goose's own database
// (verified empirically against goose 1.53.0: a `hidden`-type row with
// the run's working dir), so the ask's cleanup sweeps every row recorded
// against the glv-owned scratch directory once the run finishes. The row
// never appears in the sidebar either way — glv lists `user` sessions
// only — but a leftover row would accumulate in goose's database
// forever, and `glv logs` would show it.
const NO_SESSION_FLAGS = ["--no-session", "--output-format", "stream-json"];

// Same pairing as real runs: a model id only means something alongside
// its provider, and no selection leaves goose's own precedence in
// charge.
const modelFlags = (model: ModelSelection | undefined): string[] =>
  model === undefined
    ? []
    : ["--provider", model.provider, "--model", model.model];

const makeGooseEphemeralAsk = (
  binary: string,
  dbWritable: DatabaseSync,
  scratchDir: string,
): EphemeralAsk => ({
  name: "goose",
  binary,
  args: (model) => [
    "run",
    ...NO_SESSION_FLAGS,
    ...modelFlags(model),
    "-i",
    "-",
  ],
  env: () => ({}),
  cleanup: () => {
    deleteSessionsInDir(dbWritable, scratchDir);
  },
});

export { makeGooseEphemeralAsk };
