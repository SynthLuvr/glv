import { shortenHome } from "../../glv/format/index.js";
import type { ModelChoice } from "../../glv/models.js";
import type { SavedPrompt } from "../../glv/prompts/db.js";
import { PaperclipButton, UploadFields } from "../../glv/views/uploads.js";
import type { CronJobConfig } from "../cron-jobs.js";
import { PromptLibrarySection } from "./prompt-library.js";
import { ScheduledRunsSection } from "./schedule.js";

const WorkingDirBody = ({
  workingDir,
  dirs,
}: {
  workingDir: string;
  dirs: string[];
}) => (
  <div class="source-body" data-source-body="working_dir">
    <label class="form-field">
      <span class="form-label">Working directory</span>
      <input
        type="text"
        name="working_dir"
        list="recent-dirs"
        value={shortenHome(workingDir)}
        class="form-input"
        autocomplete="off"
        spellcheck={false}
      />
      <datalist id="recent-dirs">
        {dirs.map((dir) => (
          <option value={shortenHome(dir)} />
        ))}
      </datalist>
    </label>
  </div>
);

const TempDirBody = () => (
  <div class="source-body" data-source-body="temp" hidden>
    <p class="temp-dir-hint">
      A fresh temporary directory is created for this session and deleted
      automatically when you archive it.
    </p>
  </div>
);

// Render-ready picker state; NewSessionForm hides the field when absent.
type ModelPicker = {
  readonly choices: readonly ModelChoice[];
  readonly defaultLabel: string;
  readonly selected: string;
};

// Choices arrive provider-ordered with each provider's models contiguous;
// bucket them so the select shows one optgroup per provider.
type ModelGroup = {
  readonly provider: string;
  readonly choices: ModelChoice[];
};

const groupByProvider = (choices: readonly ModelChoice[]): ModelGroup[] => {
  const groups: ModelGroup[] = [];
  for (const choice of choices) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.provider === choice.provider)
      last.choices.push(choice);
    else groups.push({ provider: choice.provider, choices: [choice] });
  }
  return groups;
};

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

// The first option ("<agent> default — …") submits an empty value so the
// run passes no model flags and the agent's own precedence applies.
const ModelSelect = ({
  agentName,
  picker,
}: {
  agentName: string;
  picker: ModelPicker;
}) => (
  <label class="form-field">
    <span class="form-label">Model</span>
    <select name="model_provider" class="form-input">
      <option value="" selected={picker.selected === ""}>
        {agentName} default — {picker.defaultLabel}
      </option>
      {groupByProvider(picker.choices).map((group) => (
        <optgroup label={group.provider}>
          {group.choices.map((choice) => (
            <option
              value={choice.value}
              selected={picker.selected === choice.value}
            >
              {choice.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
    <span class="model-hint">
      Providers configured in {agentName} only; add more with {agentName}{" "}
      configure.
    </span>
  </label>
);

const SourceToggle = () => (
  <fieldset class="source-toggle">
    <legend class="form-label">Working location</legend>
    <div class="source-toggle-options">
      <label class="source-toggle-option">
        <input
          type="radio"
          name="session_mode"
          value="working_dir"
          data-source-radio="working_dir"
          checked
        />
        <span>Working directory</span>
      </label>
      <label class="source-toggle-option">
        <input
          type="radio"
          name="session_mode"
          value="temp"
          data-source-radio="temp"
        />
        <span>Temporary directory</span>
      </label>
    </div>
  </fieldset>
);

// The prompt-id field lets the "Run" action flag which saved prompt a session
// started from so the run flow can bump its usage stats. It is cleared on any
// manual edit so a hand-typed start never bumps a stale prompt.
const NewSessionForm = ({
  agentName,
  workingDir,
  dirs,
  error,
  prompt = "",
  prompts = [],
  categories = [],
  modelPicker,
  jobs = [],
}: {
  agentName: string;
  workingDir: string;
  dirs: string[];
  error?: string;
  /** Restores a rejected submit's prompt so nothing typed is lost. */
  prompt?: string;
  prompts?: SavedPrompt[];
  categories?: string[];
  /** When present, render the lazy picker slot; `submitted` restores a
   * rejected submit's selection across the re-render. */
  modelPicker?: { submitted?: string };
  /** Scheduled runs from the cron database — drives the management section. */
  jobs?: readonly CronJobConfig[];
}) => (
  <div class="detail-inner new-session">
    <h2>New Session</h2>
    <p class="new-session-sub">
      Start a fresh {agentName} run. The session appears in the sidebar the
      moment {agentName} creates it.
    </p>
    <form
      class="new-session-form"
      data-upload-form
      hx-post="/sessions"
      hx-target="#detail-pane"
      hx-swap="innerHTML"
      hx-encoding="multipart/form-data"
      hx-disabled-elt="button[type=submit]"
    >
      {error !== undefined && <p class="status-hint error">{error}</p>}
      <input type="hidden" name="prompt_id" value="" data-prompt-id />
      <SourceToggle />
      <div class="source-bodies" data-source-bodies>
        <WorkingDirBody workingDir={workingDir} dirs={dirs} />
        <TempDirBody />
      </div>
      {modelPicker !== undefined && (
        <ModelPickerSlot submitted={modelPicker.submitted} />
      )}
      <label class="form-field">
        <span class="form-label">Prompt</span>
        <textarea
          name="prompt"
          class="form-input prompt-input"
          rows={5}
          placeholder={`What do you want ${agentName} to do?`}
          autofocus
        >
          {prompt}
        </textarea>
      </label>
      <UploadFields />
      <p class="paste-hint">Tip: paste images with ⌘/Ctrl+V</p>
      <div class="form-actions upload-actions">
        <PaperclipButton />
        <button type="submit" class="send-btn">
          Start session
        </button>
      </div>
    </form>
    <PromptLibrarySection prompts={prompts} categories={categories} />
    <ScheduledRunsSection jobs={jobs} />
  </div>
);

const NotFoundDetail = ({ id }: { id: string }) => (
  <div class="placeholder">
    <h2>Session not found</h2>
    <p>
      No session matches <code>{id}</code>.
    </p>
  </div>
);

export {
  ModelPicker,
  ModelPickerSlot,
  ModelSelect,
  NewSessionForm,
  NotFoundDetail,
};
