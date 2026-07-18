type RepoSummary = {
  nameWithOwner: string;
  visibility: string;
  isFork: boolean;
  updatedAt: string;
};

const isRepoSummary = (value: unknown): value is RepoSummary =>
  typeof value === "object" &&
  value !== null &&
  "nameWithOwner" in value &&
  typeof value.nameWithOwner === "string" &&
  "visibility" in value &&
  typeof value.visibility === "string" &&
  "isFork" in value &&
  typeof value.isFork === "boolean" &&
  "updatedAt" in value &&
  typeof value.updatedAt === "string";

type ReposResponse = {
  ok: boolean;
  repos?: RepoSummary[];
  error?: string;
};

const isReposResponse = (value: unknown): value is ReposResponse => {
  if (typeof value !== "object" || value === null) return false;
  if (!("ok" in value) || typeof value.ok !== "boolean") return false;
  if ("repos" in value) {
    if (!Array.isArray(value.repos)) return false;
    if (!value.repos.every(isRepoSummary)) return false;
  }
  if ("error" in value && typeof value.error !== "string") return false;
  return true;
};

type BranchesResponse = {
  ok: boolean;
  branches?: string[];
  defaultBranch?: string;
  error?: string;
};

const isBranchesResponse = (value: unknown): value is BranchesResponse => {
  if (typeof value !== "object" || value === null) return false;
  if (!("ok" in value) || typeof value.ok !== "boolean") return false;
  if (
    "branches" in value &&
    !(
      Array.isArray(value.branches) &&
      value.branches.every((b) => typeof b === "string")
    )
  )
    return false;
  if ("defaultBranch" in value && typeof value.defaultBranch !== "string")
    return false;
  if ("error" in value && typeof value.error !== "string") return false;
  return true;
};

const setHiddenSource = (source: string): void => {
  const input = document.querySelector('input[name="source"]');
  if (input instanceof HTMLInputElement) input.value = source;
};

const selectSource = (source: string): void => {
  setHiddenSource(source);
  for (const seg of document.querySelectorAll("[data-source]")) {
    const selected = seg.getAttribute("data-source") === source;
    seg.classList.toggle("selected", selected);
    seg.setAttribute("aria-selected", selected ? "true" : "false");
  }
  for (const body of document.querySelectorAll("[data-source-body]"))
    body.classList.toggle(
      "source-hidden",
      body.getAttribute("data-source-body") !== source,
    );
  if (source === "github") void loadRepos();
};

const hideBranchField = (): void => {
  const field = document.querySelector("[data-branch-field]");
  if (field !== null) field.classList.add("source-hidden");
};

const updatePreview = (value: string): void => {
  const preview = document.querySelector("[data-clone-preview]");
  if (preview === null) return;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    preview.textContent = "";
    return;
  }
  preview.textContent = `→ Will clone to /tmp/glv/${trimmed.slice(0, slash)}/${trimmed.slice(slash + 1)}`;
};

const option = (value: string, label?: string): HTMLOptionElement => {
  const opt = document.createElement("option");
  opt.value = value;
  if (label !== undefined) opt.setAttribute("label", label);
  return opt;
};

const loadRepos = async (): Promise<void> => {
  const datalist = document.getElementById("gh-repos");
  if (datalist === null || datalist.children.length > 0) return;
  const errorEl = document.querySelector("[data-repo-error]");
  try {
    const res = await fetch("/github/repos");
    const data: unknown = await res.json();
    if (!isReposResponse(data)) {
      if (errorEl !== null)
        errorEl.textContent = "Could not load repositories.";
      return;
    }
    if (!data.ok) {
      if (errorEl !== null)
        errorEl.textContent = data.error ?? "Could not load repositories.";
      return;
    }
    const repos = data.repos ?? [];
    const opts = repos.map((r) => {
      const parts = [r.visibility === "PRIVATE" ? "🔒" : "🔓"];
      if (r.isFork) parts.push("fork");
      parts.push(r.updatedAt.slice(0, 10));
      return option(r.nameWithOwner, parts.join(" · "));
    });
    datalist.replaceChildren(...opts);
  } catch {
    if (errorEl !== null) errorEl.textContent = "Could not load repositories.";
  }
};

// Guard a branches race: rapid repo changes can let a slower earlier fetch
// resolve after a newer one. Abort the prior request, and ignore any
// superseded response that still slips through.
let activeBranchController: AbortController | null = null;

const BRANCH_LOAD_ERROR = "Could not load branches.";

const showBranchError = (errorEl: Element | null, message: string): void => {
  if (errorEl !== null) errorEl.textContent = message;
  hideBranchField();
};

const loadBranches = async (owner: string, repo: string): Promise<void> => {
  activeBranchController?.abort();
  const controller = new AbortController();
  activeBranchController = controller;
  const superseded = (): boolean => controller !== activeBranchController;

  const datalist = document.getElementById("gh-branches");
  const branchInput = document.querySelector('input[name="branch"]');
  const branchField = document.querySelector("[data-branch-field]");
  const errorEl = document.querySelector("[data-repo-error]");
  try {
    const res = await fetch(`/github/repos/${owner}/${repo}/branches`, {
      signal: controller.signal,
    });
    const data: unknown = await res.json();
    if (superseded()) return;
    if (!isBranchesResponse(data)) {
      showBranchError(errorEl, BRANCH_LOAD_ERROR);
      return;
    }
    if (!data.ok) {
      showBranchError(errorEl, data.error ?? BRANCH_LOAD_ERROR);
      return;
    }
    if (errorEl !== null) errorEl.textContent = "";
    if (datalist !== null)
      datalist.replaceChildren(...(data.branches ?? []).map((b) => option(b)));
    if (branchInput instanceof HTMLInputElement && branchInput.value === "")
      branchInput.value = data.defaultBranch ?? "main";
    if (branchField !== null) branchField.classList.remove("source-hidden");
  } catch {
    if (superseded()) return;
    showBranchError(errorEl, BRANCH_LOAD_ERROR);
  }
};

const handleRepoChange = (value: string): void => {
  updatePreview(value);
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    hideBranchField();
    return;
  }
  void loadBranches(trimmed.slice(0, slash), trimmed.slice(slash + 1));
};

document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  const seg = el?.closest("[data-source]");
  if (!(seg instanceof HTMLElement)) return;
  e.preventDefault();
  selectSource(seg.dataset.source ?? "working_dir");
});

document.addEventListener("keydown", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  const seg = el?.closest("[data-source]");
  if (!(seg instanceof HTMLElement)) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const segments = [...document.querySelectorAll("[data-source]")];
  const current = segments.indexOf(seg);
  const dir = e.key === "ArrowLeft" ? -1 : 1;
  const next = segments[(current + dir + segments.length) % segments.length];
  if (next instanceof HTMLElement) {
    next.focus();
    selectSource(next.dataset.source ?? "working_dir");
  }
});

document.addEventListener("change", (e) => {
  if (!(e.target instanceof HTMLInputElement) || e.target.name !== "repo")
    return;
  handleRepoChange(e.target.value);
});

document.addEventListener("input", (e) => {
  if (!(e.target instanceof HTMLInputElement) || e.target.name !== "repo")
    return;
  updatePreview(e.target.value);
});

// When the form is re-rendered with GitHub pre-selected (e.g. after a clone
// error), restore the combobox state.
const initGithubMode = (): void => {
  const form = document.querySelector(".new-session-form");
  if (form === null) return;
  const hidden = form.querySelector('input[name="source"]');
  if (!(hidden instanceof HTMLInputElement) || hidden.value !== "github")
    return;
  void loadRepos();
  const repoInput = form.querySelector('input[name="repo"]');
  if (repoInput instanceof HTMLInputElement && repoInput.value.trim() !== "")
    handleRepoChange(repoInput.value);
};

initGithubMode();
document.addEventListener("htmx:afterSettle", initGithubMode);
