import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  decodeModelValue,
  encodeModelValue,
  type ModelChoice,
  type ModelSelection,
  type ModelSource,
} from "../glv/models.js";
import { isRecord } from "../glv/parse.js";

// claude's form-value namespace has one provider — claude itself. Model
// ids ride as the model half of the pair, exactly what `--model` accepts.
const PROVIDER = "claude";

// The user-level settings file claude itself reads (the "model" field
// names the default for new sessions). Mirrors the transcript root's
// precedence in store/working-dir.ts: CLAUDE_CONFIG_DIR when the
// environment carries an absolute one, ~/.claude otherwise — so glv and
// claude always agree on where the setting lives.
const claudeSettingsPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CLAUDE_CONFIG_DIR !== undefined &&
  env.CLAUDE_CONFIG_DIR !== "" &&
  isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? join(env.CLAUDE_CONFIG_DIR, "settings.json")
    : join(homedir(), ".claude", "settings.json");

// Read per call so `/model`-saved edits surface on the next New Session
// render without a restart. A missing or malformed file degrades to "no
// configured model", which just drops the label off the default option.
const configuredModel = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(claudeSettingsPath(env), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(doc)) return undefined;
  const model = doc.model;
  return typeof model === "string" && model.trim() !== ""
    ? model.trim()
    : undefined;
};

// claude resolves its default the way the CLI does: ANTHROPIC_MODEL beats
// the settings file; with neither set, claude picks its runtime default
// and the picker labels the option without one. The --model flag and this
// surface stay in step because the run passes the same spelling the CLI
// documents: an alias ("opus") or a full model name.
const defaultSelection = (
  env: NodeJS.ProcessEnv = process.env,
): ModelSelection | undefined => {
  const model = env.ANTHROPIC_MODEL?.trim() || configuredModel(env);
  return model === undefined ? undefined : { provider: PROVIDER, model };
};

// The stable aliases claude documents (--model takes these or a full
// model name). Mode variants ("opusplan", "[1m]" context windows) are
// deliberate omissions — the picker offers models; a settings-file power
// setup keeps working via the agent's own default.
const ALIASES: readonly string[] = ["fable", "opus", "sonnet", "haiku"];

const ALIAS_CHOICES: readonly ModelChoice[] = ALIASES.map((alias) => ({
  provider: PROVIDER,
  label: alias.charAt(0).toUpperCase() + alias.slice(1),
  value: encodeModelValue(PROVIDER, alias),
}));

const makeClaudeModelSource = (): ModelSource => ({
  choices: async () => ALIAS_CHOICES,
  defaultSelection,
  // Submit validation against the static alias list — sync, no spawn: the
  // only catalogue claude exposes programmatically. An alias dropped by a
  // future claude rejects here instead of failing the run downstream.
  resolve: (value) => {
    const selection = decodeModelValue(value);
    return selection !== undefined &&
      selection.provider === PROVIDER &&
      ALIASES.includes(selection.model)
      ? selection
      : undefined;
  },
});

export { claudeSettingsPath, makeClaudeModelSource };
