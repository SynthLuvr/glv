import type { CronJobConfig } from "../cron-jobs.js";
import { shortenHome } from "../format/index.js";
import type { SavedPrompt } from "../prompts/db.js";
import { LocationButton, LocationFields } from "./location.js";
import { ModelPickerSlot } from "./model-picker.js";
import { PromptLibrarySection } from "./prompt-library.js";
import { ScheduledRunsSection } from "./schedule.js";
import { GalleryButton, PaperclipButton, UploadFields } from "./uploads.js";

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
    {/* hx-disinherit scopes the double-submit guard (hx-disabled-elt) to
        this form's own POST: htmx hands attributes down to descendant
        requests, so without it the lazy model-picker GET disabled Start
        session document-wide until the catalogue resolved. */}
    <form
      class="new-session-form"
      data-upload-form
      hx-post="/sessions"
      hx-target="#detail-pane"
      hx-swap="innerHTML"
      hx-encoding="multipart/form-data"
      hx-disabled-elt="button[type=submit]"
      hx-disinherit="hx-disabled-elt"
    >
      {error !== undefined && <p class="status-hint error">{error}</p>}
      <input type="hidden" name="prompt_id" value="" data-prompt-id />
      <SourceToggle />
      <div class="source-bodies" data-source-bodies>
        <WorkingDirBody workingDir={workingDir} dirs={dirs} />
        <TempDirBody />
      </div>
      <div class="model-picker-wrap" data-model-picker-wrap>
        {modelPicker !== undefined && (
          <ModelPickerSlot submitted={modelPicker.submitted} />
        )}
      </div>
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
      <LocationFields />
      <p class="paste-hint">Tip: paste images with ⌘/Ctrl+V</p>
      <div class="form-actions upload-actions">
        <PaperclipButton />
        <GalleryButton />
        <LocationButton />
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

export { NewSessionForm, NotFoundDetail };
