import { encodeAgentModelValue, type ModelChoice } from "../models.js";

// Render-ready picker state; NewSessionForm hides the field when absent.
type ModelPicker = {
  readonly groups: readonly AgentModelGroup[];
  /** The combined value to preselect (a restored submit, or the default
   * agent's default entry). */
  readonly selected: string;
};

// One served agent's slice of the combined model picker: its default
// entry and its choices share one optgroup, and every value carries the
// agent prefix that routes the submit.
type AgentModelGroup = {
  readonly agent: string;
  readonly label: string;
  /** "provider / model" of the agent's own default; "" when it has no
   * readable one and the option drops the suffix. */
  readonly defaultLabel: string;
  readonly choices: readonly ModelChoice[];
};

// With several providers behind one agent, a bare model label loses the
// provider context the old per-provider optgroups carried — prefix
// labels only when the agent actually spans providers.
const groupChoices = (group: AgentModelGroup) => {
  const providers = new Set(group.choices.map((choice) => choice.provider));
  return group.choices.map((choice) => ({
    value: encodeAgentModelValue(group.agent, choice.value),
    label:
      providers.size > 1
        ? `${choice.provider} / ${choice.label}`
        : choice.label,
  }));
};

// The combined picker: one select choosing the agent and the model. Each
// agent's optgroup leads with its "<agent> default" entry — an empty
// model value, so the run passes no model flags and the agent's own
// precedence applies — followed by every model it offers.
const ModelSelect = ({ picker }: { picker: ModelPicker }) => (
  <label class="form-field">
    <span class="form-label">Model</span>
    <select name="model" class="form-input">
      {picker.groups.map((group) => {
        const defaultValue = encodeAgentModelValue(group.agent, "");
        return (
          <optgroup label={group.label}>
            <option
              value={defaultValue}
              selected={picker.selected === defaultValue}
            >
              {group.label} default
              {group.defaultLabel === "" ? "" : ` — ${group.defaultLabel}`}
            </option>
            {groupChoices(group).map((choice) => (
              <option
                value={choice.value}
                selected={picker.selected === choice.value}
              >
                {choice.label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
    <span class="model-hint">
      Each agent lists the models configured in it; the default entry lets the
      agent choose. Add goose providers with goose configure.
    </span>
  </label>
);

// Stand-in rendered in place of the picker; the real <select> loads lazily
// because resolving the catalogue can spawn the agent binary, and the form
// must never wait on that.
const ModelPickerSlot = ({ submitted }: { submitted?: string }) => {
  const query = submitted ? `?submitted=${encodeURIComponent(submitted)}` : "";
  return (
    <div
      class="form-field model-picker-slot"
      hx-get={`/sessions/model-picker${query}`}
      hx-trigger="load"
      hx-target="this"
      hx-swap="outerHTML"
    >
      <span class="form-label">Model</span>
      <div class="form-input model-slot-loading" aria-busy="true">
        Loading models…
      </div>
    </div>
  );
};

export type { AgentModelGroup, ModelPicker };
export { ModelPickerSlot, ModelSelect };
