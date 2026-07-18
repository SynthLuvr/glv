import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { execa } from "execa";

type RepoInfo = {
  nameWithOwner: string;
  visibility: "PUBLIC" | "PRIVATE";
  isFork: boolean;
  updatedAt: string;
  description: string | null;
};

type BranchInfo = {
  branches: string[];
  defaultBranch: string;
};

type CloneStatus = "cloning" | "done" | "error";

type CloneJob = {
  jobId: string;
  repo: string;
  branch: string;
  clonePath: string;
  prompt: string;
  status: CloneStatus;
  error: string | undefined;
  // Set when the clone succeeds and the goose run is enqueued so the
  // clone-status poller can discover the real session id.
  tempKey: string | undefined;
  known: Set<string> | undefined;
  runStartedAt: number | undefined;
  createdAt: number;
};

type GhClient = {
  listRepos: () => Promise<RepoInfo[]>;
  listBranches: (owner: string, repo: string) => Promise<BranchInfo>;
  materialise: (
    owner: string,
    repo: string,
    branch: string,
    path: string,
  ) => Promise<void>;
};

// Hardcoded under /tmp — deliberately not configurable.
const CLONE_ROOT = join("/tmp", "glv");

// "." and ".." match the pattern but are excluded explicitly:
// path.join resolves them as current/parent directory traversal.
const NAME_RE = /^[A-Za-z0-9._-]+$/;

const isSafeSegment = (seg: string): boolean =>
  seg !== "." && seg !== ".." && NAME_RE.test(seg);

const clonePathFor = (owner: string, repo: string): string => {
  const target = join(CLONE_ROOT, owner, repo);
  // Defence in depth: never return a path outside the clone root, even
  // if a caller skips parseOwnerRepo.
  const rel = relative(CLONE_ROOT, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`clone path "${target}" escapes the clone root`);
  return target;
};

type OwnerRepo = { owner: string; repo: string };

const parseOwnerRepo = (repo: string): OwnerRepo => {
  const trimmed = repo.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1)
    throw new Error(`Invalid repository "${trimmed}". Expected owner/name.`);
  const owner = trimmed.slice(0, slash);
  const repoName = trimmed.slice(slash + 1);
  if (!isSafeSegment(owner) || !isSafeSegment(repoName))
    throw new Error(
      `Invalid repository "${trimmed}". Owner and name may only contain ` +
        "alphanumerics, '.', '_' and '-'.",
    );
  return { owner, repo: repoName };
};

const generateCloneJobId = (): string =>
  `clone_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const stderrGist = (stderr: unknown): string =>
  typeof stderr === "string" ? stderr.trim().slice(-300) : "";

const parseRepoList = (stdout: string): RepoInfo[] => {
  const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
  return raw
    .map(
      (r): RepoInfo => ({
        nameWithOwner:
          typeof r.nameWithOwner === "string" ? r.nameWithOwner : "",
        visibility: r.visibility === "PRIVATE" ? "PRIVATE" : "PUBLIC",
        isFork: r.isFork === true,
        updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
        description: typeof r.description === "string" ? r.description : null,
      }),
    )
    .filter((r) => r.nameWithOwner !== "")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

const listRepos = async (): Promise<RepoInfo[]> => {
  const { stdout } = await execa("gh", [
    "repo",
    "list",
    "--limit",
    "100",
    "--json",
    "nameWithOwner,visibility,isFork,updatedAt,description",
  ]);
  return parseRepoList(stdout);
};

const listBranches = async (
  owner: string,
  repo: string,
): Promise<BranchInfo> => {
  const viewResult = await execa("gh", [
    "repo",
    "view",
    `${owner}/${repo}`,
    "--json",
    "defaultBranchRef",
  ]);
  const view = JSON.parse(viewResult.stdout) as {
    defaultBranchRef: { name: string } | null;
  };
  const defaultBranch = view.defaultBranchRef?.name ?? "main";

  const apiResult = await execa("gh", [
    "api",
    `repos/${owner}/${repo}/branches`,
    "--paginate",
    "--jq",
    ".[].name",
  ]);
  const branches = apiResult.stdout
    .trim()
    .split("\n")
    .filter((name) => name !== "");

  if (!branches.includes(defaultBranch)) branches.unshift(defaultBranch);

  return { branches, defaultBranch };
};

const getSshUrl = async (owner: string, repo: string): Promise<string> => {
  const { stdout } = await execa("gh", [
    "repo",
    "view",
    `${owner}/${repo}`,
    "--json",
    "sshUrl",
  ]);
  const parsed = JSON.parse(stdout) as { sshUrl: string };
  return parsed.sshUrl;
};

// Clones only the selected branch (--single-branch) to keep it cheap. The
// remote URL is resolved by the caller (materialise) so this stays free of
// the gh CLI and can be exercised against a local repository in tests.
const runClone = async (
  url: string,
  branch: string,
  path: string,
): Promise<void> => {
  const result = await execa(
    "git",
    ["clone", "--branch", branch, "--single-branch", url, path],
    { reject: false },
  );
  if (result.exitCode !== 0)
    throw new Error(
      stderrGist(result.stderr) || `git clone failed for ${branch}`,
    );
};

// Cheap reuse: fetch the requested branch and reset the local branch onto the
// fetched tip instead of re-downloading. A --single-branch clone only ever
// fetched one branch, so a bare `git fetch` misses every other branch and a
// plain `git checkout <branch>` then fails with "pathspec ... did not match".
// Fetching the branch explicitly and pointing the local branch at FETCH_HEAD
// works both for the original branch and for any branch the caller switches
// to, always landing on the latest remote tip. The old `git pull` step is
// gone: the single-branch refspec made it a no-op for switched branches and
// `checkout -B ... FETCH_HEAD` already syncs the tip.
const runUpdate = async (path: string, branch: string): Promise<void> => {
  const steps: Array<[string, string[]]> = [
    ["fetch", ["origin", branch]],
    ["checkout", ["-B", branch, "FETCH_HEAD"]],
  ];
  for (const [cmd, args] of steps) {
    const result = await execa("git", [cmd, ...args], {
      cwd: path,
      reject: false,
    });
    if (result.exitCode !== 0)
      throw new Error(stderrGist(result.stderr) || `git ${cmd} failed`);
  }
};

const materialise = async (
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<void> => {
  if (existsSync(path)) {
    await runUpdate(path, branch);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const url = await getSshUrl(owner, repo);
  await runClone(url, branch, path);
};

const createGhClient = (): GhClient => ({
  listRepos,
  listBranches,
  materialise,
});

export type {
  BranchInfo,
  CloneJob,
  CloneStatus,
  GhClient,
  OwnerRepo,
  RepoInfo,
};
export {
  CLONE_ROOT,
  clonePathFor,
  createGhClient,
  generateCloneJobId,
  parseOwnerRepo,
  runClone,
  runUpdate,
};
