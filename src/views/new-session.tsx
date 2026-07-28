import { shortenHome } from "../format/index.js";
import type { SavedPrompt } from "../prompts/db.js";
import { PromptLibrarySection } from "./prompt-library.js";

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

// The prompt-id field lets the "Run" action flag which saved prompt a session
// started from so the run flow can bump its usage stats. It is cleared on any
// manual edit so a hand-typed start never bumps a stale prompt.
const NewSessionForm = ({
  workingDir,
  dirs,
  error,
  prompts = [],
  categories = [],
}: {
  workingDir: string;
  dirs: string[];
  error?: string;
  prompts?: SavedPrompt[];
  categories?: string[];
}) => (
  <div class="detail-inner new-session">
    <h2>New Session</h2>
    <p class="new-session-sub">
      Start a fresh goose run. The session appears in the sidebar the moment
      goose creates it.
    </p>
    <form
      class="new-session-form"
      hx-post="/sessions"
      hx-target="#detail-pane"
      hx-swap="innerHTML"
      hx-encoding="multipart/form-data"
      hx-disabled-elt="button[type=submit]"
    >
      {error !== undefined && <p class="status-hint error">{error}</p>}
      <input type="hidden" name="prompt_id" value="" data-prompt-id />
      <WorkingDirBody workingDir={workingDir} dirs={dirs} />
      <label class="form-field">
        <span class="form-label">Prompt</span>
        <textarea
          name="prompt"
          class="form-input prompt-input"
          rows={5}
          placeholder="What do you want goose to do?"
          autofocus
        />
      </label>
      <input
        type="file"
        name="uploads"
        multiple
        class="upload-input-hidden"
        accept="image/*,application/pdf,text/*,.md,.txt,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.sql"
      />
      <p class="upload-error" style="display:none" />
      <div class="upload-chips" style="display:none" />
      <div class="form-actions upload-actions">
        <button
          type="button"
          class="paperclip-btn"
          aria-label="Attach files"
          title="Attach files"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M13.234 20.252 21 12.3" />
            <path d="M16 6a8.077 8.077 0 0 1-8 8 6 6 0 0 1-6-6 4 4 0 0 1 4-4 2.5 2.5 0 0 1 2.5 2.5 1.5 1.5 0 0 1-1.5 1.5" />
          </svg>
          <span>Attach files</span>
        </button>
        <button type="submit" class="send-btn">
          Start session
        </button>
      </div>
    </form>
    <PromptLibrarySection prompts={prompts} categories={categories} />
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
