import { shortenHome } from "../format/index.js";
import type { PromptSort, SavedPrompt } from "../prompts/db.js";

type SourceType = "working_dir" | "github";

const clonePathPreview = (repo: string): string => {
  const trimmed = repo.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return "";
  return `/tmp/glv/${trimmed.slice(0, slash)}/${trimmed.slice(slash + 1)}`;
};

const SourceToggle = ({ source }: { source: SourceType }) => (
  <div class="source-toggle" role="tablist" aria-label="Session source">
    <button
      type="button"
      class={`source-seg${source === "working_dir" ? " selected" : ""}`}
      role="tab"
      aria-selected={source === "working_dir" ? "true" : "false"}
      data-source="working_dir"
    >
      📁 Working Directory
    </button>
    <button
      type="button"
      class={`source-seg${source === "github" ? " selected" : ""}`}
      role="tab"
      aria-selected={source === "github" ? "true" : "false"}
      data-source="github"
    >
      🐙 GitHub Repository
    </button>
  </div>
);

const WorkingDirBody = ({
  workingDir,
  dirs,
  hidden,
}: {
  workingDir: string;
  dirs: string[];
  hidden: boolean;
}) => (
  <div
    class={`source-body${hidden ? " source-hidden" : ""}`}
    data-source-body="working_dir"
  >
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

const GitHubBody = ({
  repo,
  branch,
  hidden,
}: {
  repo?: string;
  branch?: string;
  hidden: boolean;
}) => {
  const hasRepo = repo !== undefined && repo.trim() !== "";
  return (
    <div
      class={`source-body${hidden ? " source-hidden" : ""}`}
      data-source-body="github"
    >
      <label class="form-field">
        <span class="form-label">Repository</span>
        <input
          type="text"
          name="repo"
          list="gh-repos"
          value={repo ?? ""}
          class="form-input"
          placeholder="Search your repositories…"
          autocomplete="off"
          spellcheck={false}
        />
        <datalist id="gh-repos"></datalist>
      </label>
      <p class="gh-picker-error" data-repo-error></p>
      <label
        class={`form-field${hasRepo ? "" : " source-hidden"}`}
        data-branch-field
      >
        <span class="form-label">Branch</span>
        <input
          type="text"
          name="branch"
          list="gh-branches"
          value={branch ?? ""}
          class="form-input"
          placeholder="main"
          autocomplete="off"
          spellcheck={false}
        />
        <datalist id="gh-branches"></datalist>
      </label>
      {hasRepo && (
        <p class="clone-preview" data-clone-preview>
          → Will clone to {clonePathPreview(repo!)}
        </p>
      )}
    </div>
  );
};

// The prompt-id field lets the "Run" action flag which saved prompt a session
// started from so the run flow can bump its usage stats. It is cleared on any
// manual edit so a hand-typed start never bumps a stale prompt.
const NewSessionForm = ({
  workingDir,
  dirs,
  error,
  source = "working_dir",
  repo,
  branch,
  prompts = [],
  categories = [],
}: {
  workingDir: string;
  dirs: string[];
  error?: string;
  source?: SourceType;
  repo?: string;
  branch?: string;
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
      hx-disabled-elt="button[type=submit]"
    >
      {error !== undefined && <p class="status-hint error">{error}</p>}
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="prompt_id" value="" data-prompt-id />
      <SourceToggle source={source} />
      <WorkingDirBody
        workingDir={workingDir}
        dirs={dirs}
        hidden={source !== "working_dir"}
      />
      <GitHubBody repo={repo} branch={branch} hidden={source !== "github"} />
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
      <div class="form-actions">
        <button type="submit" class="send-btn">
          Start session
        </button>
      </div>
    </form>
    <PromptLibrarySection prompts={prompts} categories={categories} />
  </div>
);

const PromptCategoryDatalist = ({ categories }: { categories: string[] }) => (
  <datalist id="prompt-categories">
    {categories.map((c) => (
      <option value={c} />
    ))}
  </datalist>
);

// `grouped` hides the per-card category tag (redundant inside a labelled
// section). The card is draggable; the grip handle gates the drag so button
// clicks and text selection never start a reorder.
const PromptCard = ({
  prompt,
  grouped = false,
}: {
  prompt: SavedPrompt;
  grouped?: boolean;
}) => (
  <article
    class="prompt-card"
    id={`prompt-card-${prompt.id}`}
    draggable="true"
    data-prompt-id={prompt.id}
  >
    <div class="prompt-card-head">
      <span
        class="prompt-drag-handle"
        title="Drag to reorder"
        aria-hidden="true"
      >
        ⠿
      </span>
      <h4 class="prompt-card-title">{prompt.title}</h4>
      {!grouped && prompt.category !== null && (
        <span class="prompt-tag">🏷 {prompt.category}</span>
      )}
    </div>
    <p class="prompt-card-body">{prompt.body}</p>
    <div class="prompt-card-actions">
      <button
        type="button"
        class="prompt-card-btn use"
        data-action="use"
        data-prompt-body={prompt.body}
      >
        Use
      </button>
      <button
        type="button"
        class="prompt-card-btn run"
        data-action="run"
        data-prompt-id={prompt.id}
        data-prompt-body={prompt.body}
      >
        ▶ Run
      </button>
      <button
        type="button"
        class="prompt-card-btn edit"
        hx-get={`/prompts/${prompt.id}/edit`}
        hx-target={`#prompt-card-${prompt.id}`}
        hx-swap="outerHTML"
      >
        Edit
      </button>
      <button
        type="button"
        class="prompt-card-btn delete"
        hx-delete={`/prompts/${prompt.id}`}
        hx-target={`#prompt-card-${prompt.id}`}
        hx-swap="outerHTML"
        hx-confirm="Delete this saved prompt?"
      >
        Delete
      </button>
    </div>
  </article>
);

// Groups prompts by category, preserving the underlying list order within
// each group. Categorised groups sort alphabetically; uncategorised (null)
// always sinks to the end so labelled sections come first.
const groupPrompts = (
  prompts: SavedPrompt[],
): { category: string | null; items: SavedPrompt[] }[] => {
  const groups = new Map<string | null, SavedPrompt[]>();
  for (const prompt of prompts) {
    const key = prompt.category;
    const items = groups.get(key) ?? [];
    items.push(prompt);
    groups.set(key, items);
  }
  return [...groups.entries()]
    .map(([category, items]) => ({ category, items }))
    .sort((a, b) => {
      if (a.category === null) return 1;
      if (b.category === null) return -1;
      return a.category.localeCompare(b.category);
    });
};

// View-mode toggles. Each is an htmx link that re-renders #prompt-library with
// the flipped query param, reflecting its active state via the `.active` class.
const PromptToolbar = ({
  grouped,
  sortBy,
}: {
  grouped: boolean;
  sortBy: PromptSort;
}) => {
  const usageNext = sortBy === "usage" ? "order" : "usage";
  const groupNext = grouped ? "0" : "1";
  const usageParams = `sort=${usageNext}${grouped ? "&grouped=1" : ""}`;
  const groupParams = `grouped=${groupNext}${sortBy === "usage" ? "&sort=usage" : ""}`;
  return (
    <div class="prompt-toolbar">
      <button
        type="button"
        class={`prompt-toggle${sortBy === "usage" ? " active" : ""}`}
        title="Sort by how often each prompt is run"
        hx-get={`/prompts?${usageParams}`}
        hx-target="#prompt-library"
        hx-swap="outerHTML"
      >
        ★ Frequently used
      </button>
      <button
        type="button"
        class={`prompt-toggle${grouped ? " active" : ""}`}
        title="Group prompts into collapsible category sections"
        hx-get={`/prompts?${groupParams}`}
        hx-target="#prompt-library"
        hx-swap="outerHTML"
      >
        🏷 Group by category
      </button>
    </div>
  );
};

// Rendered both inline (initial load, GET /prompts) and out-of-band (after a
// create) so a freshly saved card appears without a full reload. `oob`
// attaches hx-swap-oob so htmx drops it into #prompt-library from any response.
const PromptLibrary = ({
  prompts,
  categories,
  grouped = false,
  sortBy = "order",
  oob = false,
}: {
  prompts: SavedPrompt[];
  categories: string[];
  grouped?: boolean;
  sortBy?: PromptSort;
  oob?: boolean;
}) => (
  <div
    id="prompt-library"
    class={`prompt-library${grouped ? " grouped" : ""}`}
    {...(oob ? { "hx-swap-oob": "true" } : {})}
  >
    <PromptCategoryDatalist categories={categories} />
    <input
      type="search"
      class="prompt-filter"
      placeholder="🔍 Filter prompts…"
      autocomplete="off"
      data-prompt-filter
    />
    <PromptToolbar grouped={grouped} sortBy={sortBy} />
    {prompts.length === 0 ? (
      <p class="prompt-empty">
        No saved prompts yet. Use “Save current prompt” to add one.
      </p>
    ) : grouped ? (
      groupPrompts(prompts).map((group) => (
        <details class="prompt-group" open>
          <summary class="prompt-group-head">
            <span class="prompt-group-name">
              {group.category ?? "Ungrouped"}
            </span>
            <span class="prompt-group-count">{group.items.length}</span>
          </summary>
          <div class="prompt-grid" data-prompt-grid>
            {group.items.map((p) => (
              <PromptCard prompt={p} grouped />
            ))}
          </div>
        </details>
      ))
    ) : (
      <div class="prompt-grid" data-prompt-grid>
        {prompts.map((p) => (
          <PromptCard prompt={p} />
        ))}
      </div>
    )}
  </div>
);

// The save form targets its own slot (innerHTML) so a validation error
// re-renders in place, while a successful save clears the slot and refreshes
// the grid out-of-band.
const PromptSaveForm = ({
  title = "",
  body = "",
  category = "",
  error,
}: {
  title?: string;
  body?: string;
  category?: string;
  error?: string;
}) => (
  <form
    class="prompt-form"
    data-prompt-form="save"
    hx-post="/prompts"
    hx-target="#prompt-save-slot"
    hx-swap="innerHTML"
  >
    {error !== undefined && <p class="status-hint error">{error}</p>}
    <label class="form-field">
      <span class="form-label">Title</span>
      <input
        type="text"
        name="title"
        class="form-input"
        value={title}
        placeholder="e.g. Fix failing tests"
        required
        maxlength={120}
        autocomplete="off"
      />
    </label>
    <label class="form-field">
      <span class="form-label">Body</span>
      <textarea
        name="body"
        class="form-input"
        rows={4}
        placeholder="The prompt text goose will receive"
        required
      >
        {body}
      </textarea>
    </label>
    <label class="form-field">
      <span class="form-label">Category (optional)</span>
      <input
        type="text"
        name="category"
        class="form-input"
        list="prompt-categories"
        value={category}
        placeholder="tests, review, docs…"
        autocomplete="off"
      />
    </label>
    <div class="prompt-form-actions">
      <button type="submit" class="prompt-save-btn">
        Save
      </button>
      <button type="button" class="prompt-cancel-btn" data-action="close-save">
        Cancel
      </button>
    </div>
  </form>
);

// Edit form keeps the card's id on its wrapping <article> so the outerHTML
// swap preserves the anchor whether it renders the form or the card back.
const PromptEditForm = ({
  id,
  title,
  body,
  category,
  error,
}: {
  id: string;
  title: string;
  body: string;
  category: string;
  error?: string;
}) => (
  <article class="prompt-card editing" id={`prompt-card-${id}`}>
    <form
      class="prompt-form"
      hx-put={`/prompts/${id}`}
      hx-target={`#prompt-card-${id}`}
      hx-swap="outerHTML"
    >
      {error !== undefined && <p class="status-hint error">{error}</p>}
      <label class="form-field">
        <span class="form-label">Title</span>
        <input
          type="text"
          name="title"
          class="form-input"
          value={title}
          required
          maxlength={120}
          autocomplete="off"
        />
      </label>
      <label class="form-field">
        <span class="form-label">Body</span>
        <textarea name="body" class="form-input" rows={4} required>
          {body}
        </textarea>
      </label>
      <label class="form-field">
        <span class="form-label">Category (optional)</span>
        <input
          type="text"
          name="category"
          class="form-input"
          list="prompt-categories"
          value={category}
          autocomplete="off"
        />
      </label>
      <div class="prompt-form-actions">
        <button type="submit" class="prompt-save-btn">
          Save
        </button>
        <button
          type="button"
          class="prompt-cancel-btn"
          hx-get={`/prompts/${id}/card`}
          hx-target={`#prompt-card-${id}`}
          hx-swap="outerHTML"
        >
          Cancel
        </button>
      </div>
    </form>
  </article>
);

const PromptLibrarySection = ({
  prompts,
  categories,
}: {
  prompts: SavedPrompt[];
  categories: string[];
}) => (
  <section class="prompt-library-section">
    <div class="prompt-library-head">
      <h3 class="prompt-library-title">Saved prompts</h3>
      <button
        type="button"
        class="prompt-save-toggle"
        data-action="open-save"
        hx-get="/prompts/new"
        hx-target="#prompt-save-slot"
        hx-swap="innerHTML"
      >
        💾 Save current prompt
      </button>
    </div>
    {/* Swapped in by htmx on demand; empty until the user opens it. */}
    <div id="prompt-save-slot" class="prompt-save-slot"></div>
    <PromptLibrary prompts={prompts} categories={categories} />
  </section>
);

const CloningView = ({
  repo,
  branch,
  jobId,
  cloning,
}: {
  repo: string;
  branch: string;
  jobId: string;
  cloning: boolean;
}) => (
  <div
    class="detail-inner cloning-view"
    hx-get={`/github/clone-status/${jobId}`}
    hx-trigger="every 1s"
    hx-target="#detail-pane"
    hx-swap="innerHTML"
  >
    <div class="clone-card">
      <span class="clone-spinner" aria-hidden="true"></span>
      {cloning ? (
        <p class="status-hint running">
          Cloning <strong>{repo}</strong> ({branch})…
        </p>
      ) : (
        <p class="status-hint running">Starting session…</p>
      )}
    </div>
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
  CloningView,
  NewSessionForm,
  NotFoundDetail,
  PromptCard,
  PromptEditForm,
  PromptLibrary,
  PromptSaveForm,
  SourceType,
};
