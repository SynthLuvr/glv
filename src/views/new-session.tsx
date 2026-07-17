import { shortenHome } from "../format/index.js";

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

const NewSessionForm = ({
  workingDir,
  dirs,
  error,
  source = "working_dir",
  repo,
  branch,
}: {
  workingDir: string;
  dirs: string[];
  error?: string;
  source?: SourceType;
  repo?: string;
  branch?: string;
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
  </div>
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

export { CloningView, NewSessionForm, NotFoundDetail, SourceType };
