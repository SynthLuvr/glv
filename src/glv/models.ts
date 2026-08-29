type ModelSelection = {
  /** Provider name and model id pair that selects what a run uses. */
  readonly provider: string;
  readonly model: string;
};

/** One dropdown entry: a configured provider and the model it offers. */
type ModelChoice = {
  readonly provider: string;
  /** Dropdown label, e.g. "anthropic — claude-sonnet-4-5". */
  readonly label: string;
};

/**
 * The model surface a flavor exposes to the shared UI: per-run model
 * selection, threaded from the New Session form to the agent's argv.
 * Defined flavor-agnostically; only flavors whose agent supports model
 * overrides (goose) wire one. All functions read fresh state per call so
 * a config edited while the server runs is picked up without a restart.
 */
type ModelSource = {
  /** Configured models for the dropdown; [] when none are configured. */
  readonly choices: () => readonly ModelChoice[];
  /** The agent's own default, resolved the way the agent resolves it. */
  readonly defaultSelection: () => ModelSelection | undefined;
  /**
   * Validates a submitted provider name against current config; undefined
   * when that provider has no (usable) model anymore.
   */
  readonly resolve: (provider: string) => ModelSelection | undefined;
};

export type { ModelChoice, ModelSelection, ModelSource };
