import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { type } from "arktype";
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

// `gh` may exit 0 with non-JSON stdout (an update notice, a warning, or
// unauthenticated help text); degrade rather than crash on a SyntaxError.
const tryParseJson = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

// nameWithOwner is required; the rest are optional and defaulted so a
// malformed or non-repo line is dropped instead of crashing.
const RepoRecord = type({
  nameWithOwner: "string",
  "visibility?": "string",
  "isFork?": "boolean",
  "updatedAt?": "string",
  "description?": "string | null",
});

type RepoRecord = typeof RepoRecord.infer;

const toRepoInfo = (r: RepoRecord): RepoInfo => ({
  nameWithOwner: r.nameWithOwner,
  visibility: r.visibility === "private" ? "PRIVATE" : "PUBLIC",
  isFork: r.isFork === true,
  updatedAt: r.updatedAt ?? "",
  description: r.description ?? null,
});

// `gh api ... --paginate --jq` emits one repo object per line (JSONL),
// so each line is parsed on its own rather than as a single JSON array.
const parseRepoList = (stdout: string): RepoInfo[] =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const parsed = tryParseJson(line);
      if (parsed === null) return undefined;
      const record = RepoRecord(parsed);
      return record instanceof type.errors ? undefined : record;
    })
    .filter((r): r is RepoRecord => r !== undefined)
    .map(toRepoInfo)
    .filter((r) => r.nameWithOwner !== "")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

// `gh repo list` caps at a finite `--limit` with no `--paginate`, silently
// dropping repos beyond it. The REST endpoint paginates fully (as listBranches
// does) and `type=owner` matches the "repositories I own" set, so nothing is
// lost.
const REPO_LIST_JQ =
  ".[] | {nameWithOwner: .full_name, visibility: .visibility," +
  " isFork: .fork, updatedAt: .updated_at, description: .description}";

const listRepos = async (): Promise<RepoInfo[]> => {
  const { stdout } = await execa("gh", [
    "api",
    "user/repos?type=owner&per_page=100",
    "--paginate",
    "--jq",
    REPO_LIST_JQ,
  ]);
  return parseRepoList(stdout);
};

const DefaultBranchView = type({
  "defaultBranchRef?": type({ name: "string" }).or("null"),
});

const parseDefaultBranch = (stdout: string): string => {
  const parsed = tryParseJson(stdout);
  if (parsed === null) return "main";
  const view = DefaultBranchView(parsed);
  if (view instanceof type.errors) return "main";
  return view.defaultBranchRef?.name ?? "main";
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
  const defaultBranch = parseDefaultBranch(viewResult.stdout);

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

// No safe fallback for a missing sshUrl, so surface a structured error
// rather than degrade silently.
const SshUrlView = type({ "sshUrl?": "unknown" });

const parseSshUrl = (stdout: string): string => {
  const tail = stdout.trim().slice(-200);
  const parsed = tryParseJson(stdout);
  if (parsed === null)
    throw new Error(`gh repo view printed non-JSON output: "${tail}"`);
  const view = SshUrlView(parsed);
  if (view instanceof type.errors)
    throw new Error(`gh repo view printed non-JSON output: "${tail}"`);
  const { sshUrl } = view;
  if (typeof sshUrl !== "string" || sshUrl === "")
    throw new Error(`gh repo view did not return an sshUrl: "${tail}"`);
  return sshUrl;
};

const getSshUrl = async (owner: string, repo: string): Promise<string> => {
  const { stdout } = await execa("gh", [
    "repo",
    "view",
    `${owner}/${repo}`,
    "--json",
    "sshUrl",
  ]);
  return parseSshUrl(stdout);
};

const runGit = async (
  args: string[],
  failure: string,
  cwd?: string,
): Promise<void> => {
  const result = await execa("git", args, { cwd, reject: false });
  if (result.exitCode !== 0)
    throw new Error(stderrGist(result.stderr) || failure);
};

// --single-branch keeps the clone cheap. The URL is passed in (rather than
// resolved via gh) so this can run against a local repo in tests.
const runClone = async (
  url: string,
  branch: string,
  path: string,
): Promise<void> => {
  await runGit(
    ["clone", "--branch", branch, "--single-branch", url, path],
    `git clone failed for ${branch}`,
  );
};

// A --single-branch clone tracks only one ref, so fetch the target branch
// explicitly and reset onto FETCH_HEAD. A plain checkout would fail for any
// branch the clone never fetched.
const runUpdate = async (path: string, branch: string): Promise<void> => {
  await runGit(["fetch", "origin", branch], "git fetch failed", path);
  await runGit(
    ["checkout", "-B", branch, "FETCH_HEAD"],
    "git checkout failed",
    path,
  );
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

export type { CloneJob, GhClient };
export { clonePathFor, createGhClient, generateCloneJobId, parseOwnerRepo };
