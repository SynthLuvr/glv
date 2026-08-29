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

export type { ModelChoice, ModelSelection, ModelSource };
