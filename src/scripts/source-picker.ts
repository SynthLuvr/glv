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

const loadRepos = async (): Promise<void> => {
  const datalist = document.getElementById("gh-repos");
  if (datalist === null || datalist.children.length > 0) return;
  const errorEl = document.querySelector("[data-repo-error]");
  try {
    const res = await fetch("/github/repos");
    const data = await res.json();
    if (!data.ok) {
      if (errorEl !== null)
        errorEl.textContent = data.error ?? "Could not load repositories.";
      return;
    }
    const repos = data.repos as Array<{
      nameWithOwner: string;
      visibility: string;
      isFork: boolean;
      updatedAt: string;
    }>;
    datalist.innerHTML = repos
      .map((r) => {
        const parts = [r.visibility === "PRIVATE" ? "🔒" : "🔓"];
        if (r.isFork) parts.push("fork");
        parts.push(r.updatedAt.slice(0, 10));
        const label = parts.join(" · ");
        return `<option value="${r.nameWithOwner}" label="${label}"></option>`;
      })
      .join("");
  } catch {
    if (errorEl !== null) errorEl.textContent = "Could not load repositories.";
  }
};

const loadBranches = async (owner: string, repo: string): Promise<void> => {
  const datalist = document.getElementById("gh-branches");
  const branchInput = document.querySelector('input[name="branch"]');
  const branchField = document.querySelector("[data-branch-field]");
  const errorEl = document.querySelector("[data-repo-error]");
  try {
    const res = await fetch(`/github/repos/${owner}/${repo}/branches`);
    const data = await res.json();
    if (!data.ok) {
      if (errorEl !== null)
        errorEl.textContent = data.error ?? "Could not load branches.";
      hideBranchField();
      return;
    }
    if (errorEl !== null) errorEl.textContent = "";
    if (datalist !== null)
      datalist.innerHTML = (data.branches as string[])
        .map((b) => `<option value="${b}"></option>`)
        .join("");
    if (branchInput instanceof HTMLInputElement && branchInput.value === "")
      branchInput.value = data.defaultBranch ?? "main";
    if (branchField !== null) branchField.classList.remove("source-hidden");
  } catch {
    if (errorEl !== null) errorEl.textContent = "Could not load branches.";
    hideBranchField();
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
