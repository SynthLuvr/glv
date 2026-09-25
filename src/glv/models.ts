import { isAgentId } from "./agents.js";

type ModelSelection = {
  readonly provider: string;
  readonly model: string;
};

/** One dropdown entry: a specific model an agent offers. */
type ModelChoice = {
  readonly provider: string;
  /** Dropdown label, e.g. "GLM-5.1" or "Opus". */
  readonly label: string;
  /** Submitted form value; whatever the agent's resolve() accepts. */
  readonly value: string;
};

/**
 * The model surface a flavor exposes to the shared UI: per-run model
 * selection, threaded from the New Session form to the agent's argv.
 * Every served flavor wires one; functions read fresh state per call so
 * a config edited while the server runs is picked up without a restart.
 */
type ModelSource = {
  /**
   * Every model the agent offers, agent-ordered (the combined form
   * renders one optgroup per agent). Values are opaque strings —
   * whatever this source's `resolve` accepts. Resolving the catalogue
   * may spawn the agent binary, so this is async; implementations
   * cache. [] when nothing is offered.
   */
  readonly choices: () => Promise<readonly ModelChoice[]>;
  /**
   * The agent's own default, resolved the way the agent resolves it —
   * undefined when it has no readable default (the combined picker then
   * labels the agent's default option without one).
   */
  readonly defaultSelection: () => ModelSelection | undefined;
  /**
   * Validates a submitted form value against current config; undefined
   * when the model is not one the agent offers. Sync on purpose: it
   * consults only what is already cached so submitting never pays the
   * catalogue cost.
   */
  readonly resolve: (value: string) => ModelSelection | undefined;
};

// The form-value spelling of a picker choice: "provider:model", split at
// the first colon because model ids may contain colons while provider ids
// never do. Shared by the New Session picker and the scheduled-run forms.
const encodeModelValue = (provider: string, model: string): string =>
  `${provider}:${model}`;

const decodeModelValue = (value: string): ModelSelection | undefined => {
  const sep = value.indexOf(":");
  if (sep <= 0 || sep === value.length - 1) return undefined;
  return { provider: value.slice(0, sep), model: value.slice(sep + 1) };
};

// The combined picker's spelling: "<agent>:<model value>", one select
// choosing both the agent and the model. The agent is split at the first
// colon (agent ids never contain one); the remainder is the agent's own
// form value, empty for "this agent on its default". A bare agent name
// without the colon is the invalid spelling, kept distinct from "" so a
// stale or hand-mangled submit still rejects instead of silently
// rerouting to the default agent.
type AgentModelPick =
  | { kind: "empty" }
  | { kind: "pick"; agent: string; modelValue: string }
  | { kind: "invalid" };

const encodeAgentModelValue = (agent: string, modelValue: string): string =>
  `${agent}:${modelValue}`;

const decodeAgentModelValue = (value: string): AgentModelPick => {
  if (value === "") return { kind: "empty" };
  const sep = value.indexOf(":");
  if (sep <= 0) return { kind: "invalid" };
  const agent = value.slice(0, sep);
  if (!isAgentId(agent)) return { kind: "invalid" };
  return { kind: "pick", agent, modelValue: value.slice(sep + 1) };
};

// A cron job's stored model pin (the cron row's modelProvider/model
// pair): both keys together, or neither for the agent's own default.
type ModelPin = {
  readonly modelProvider?: string;
  readonly model?: string;
};

// The selection a stored pin names, or undefined when the job runs the
// agent's own default.
const jobModelSelection = (pin: ModelPin): ModelSelection | undefined =>
  pin.modelProvider !== undefined && pin.model !== undefined
    ? { provider: pin.modelProvider, model: pin.model }
    : undefined;

// The stored spelling of a selection: both keys, or neither.
const modelPinFields = (selection: ModelSelection | undefined): ModelPin =>
  selection === undefined
    ? {}
    : { modelProvider: selection.provider, model: selection.model };

// The picker's submitted value for a stored pin: "" when the job runs
// the agent default.
const jobModelValue = (pin: ModelPin): string => {
  const selection = jobModelSelection(pin);
  return selection === undefined
    ? ""
    : encodeModelValue(selection.provider, selection.model);
};

// Rejection copy for a submitted pick that no longer resolves — shared
// by the New Session and scheduled-run submits so the flows read alike.
const modelUnavailableError = (agentName: string): string =>
  `That model is no longer available in ${agentName}. Pick another from the list.`;

// The "provider / model" rendering used by confirmations and cards.
const modelLabel = ({ provider, model }: ModelSelection): string =>
  `${provider} / ${model}`;

export type {
  AgentModelPick,
  ModelChoice,
  ModelPin,
  ModelSelection,
  ModelSource,
};
export {
  decodeAgentModelValue,
  decodeModelValue,
  encodeAgentModelValue,
  encodeModelValue,
  jobModelSelection,
  jobModelValue,
  modelLabel,
  modelPinFields,
  modelUnavailableError,
};
