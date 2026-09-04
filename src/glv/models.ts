type ModelSelection = {
  readonly provider: string;
  readonly model: string;
};

/** One dropdown entry: a specific model offered by a configured provider. */
type ModelChoice = {
  readonly provider: string;
  /** Dropdown label, e.g. "GLM-5.1" or a bare model id. */
  readonly label: string;
  /** Submitted form value encoding the provider/model pair. */
  readonly value: string;
};

/**
 * The model surface a flavor exposes to the shared UI: per-run model
 * selection, threaded from the New Session form to the agent's argv.
 * Only flavors whose agent supports model overrides (goose) wire one;
 * functions read fresh state per call so a config edited while the
 * server runs is picked up without a restart.
 */
type ModelSource = {
  /**
   * Every model each configured provider offers, provider-ordered with
   * each provider's models contiguous (the form renders one optgroup
   * per provider). Resolving the catalogue may spawn the agent binary,
   * so this is async; implementations cache. [] when nothing is
   * configured.
   */
  readonly choices: () => Promise<readonly ModelChoice[]>;
  /** The agent's own default, resolved the way the agent resolves it. */
  readonly defaultSelection: () => ModelSelection | undefined;
  /**
   * Validates a submitted form value against current config; undefined
   * when the provider is no longer configured or the model is not one
   * it offers. Sync on purpose: it consults only what is already cached
   * so submitting never pays the catalogue cost.
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

// A cron job's stored model pin (the config file's modelProvider/model
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

// The config-file spelling of a selection: both keys, or neither.
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

export type { ModelChoice, ModelPin, ModelSelection, ModelSource };
export {
  decodeModelValue,
  encodeModelValue,
  jobModelSelection,
  jobModelValue,
  modelLabel,
  modelPinFields,
  modelUnavailableError,
};
