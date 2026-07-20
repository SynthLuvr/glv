import { execGit } from "./shell.js";

type GitResult = { stdout: string; exitCode: number };

type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 5000;

// A non-repo (non-zero exit) or a missing git binary both degrade to an empty
// GitInfo — the former via exitCode, the latter caught by readGitInfo.
const runGit: GitRunner = async (args, cwd) => {
  const { stdout, exitCode } = await execGit(args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return { stdout, exitCode };
};

type GitInfo = {
  branch?: string;
  worktree?: string;
};

type WorktreeBlock = {
  path: string;
  branch?: string;
  detached: boolean;
};

// `git worktree list --porcelain` emits blank-line-separated blocks opening
// with `worktree <path>` and a `branch refs/heads/<name>` or `detached` line.
const parseWorktreeList = (stdout: string): WorktreeBlock[] => {
  const blocks: WorktreeBlock[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  let detached = false;
  const flush = (): void => {
    if (path !== undefined) blocks.push({ path, branch, detached });
    path = undefined;
    branch = undefined;
    detached = false;
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch "))
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "detached") detached = true;
  }
  flush();
  return blocks;
};

// A session may run in a subdirectory of a worktree, so pick the deepest
// (most specific) enclosing path.
const findWorktree = (
  blocks: readonly WorktreeBlock[],
  cwd: string,
): WorktreeBlock | undefined => {
  const matches = blocks
    .filter((b) => cwd === b.path || cwd.startsWith(`${b.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0];
};

// Walks candidate paths (most-recent-first) and returns the worktree enclosing
// the first match. `excludePath` (the launch worktree) is skipped so a session
// that worked in a different worktree is reported instead of its launch dir.
const selectWorktreeByPaths = (
  blocks: readonly WorktreeBlock[],
  paths: readonly string[],
  excludePath?: string,
): WorktreeBlock | undefined => {
  for (const path of paths) {
    const block = findWorktree(blocks, path);
    if (block === undefined) continue;
    if (excludePath !== undefined && block.path === excludePath) continue;
    return block;
  }
  return undefined;
};

const resolveGitInfo = async (
  cwd: string,
  run: GitRunner,
  paths: readonly string[] = [],
): Promise<GitInfo> => {
  const result = await run(["worktree", "list", "--porcelain"], cwd);
  if (result.exitCode !== 0) return {};
  const blocks = parseWorktreeList(result.stdout);
  const launch = findWorktree(blocks, cwd);
  // A session launched from one worktree (e.g. `main`) may `git worktree add`
  // a second and do all its work there. Recover that worktree from the paths
  // the transcript touched, preferring it over the bare launch dir.
  const block = selectWorktreeByPaths(blocks, paths, launch?.path) ?? launch;
  if (block === undefined) return {};
  const info: GitInfo = { worktree: block.path };
  if (!block.detached && block.branch !== undefined && block.branch !== "")
    info.branch = block.branch;
  return info;
};

const readGitInfo = async (
  cwd: string,
  run: GitRunner = runGit,
  paths: readonly string[] = [],
): Promise<GitInfo> => {
  try {
    return await resolveGitInfo(cwd, run, paths);
  } catch {
    return {};
  }
};

// The worktree checked out on `branch` (exact, case-sensitive match). A
// detached HEAD has no branch, so it never matches.
const findWorktreeByBranch = (
  blocks: readonly WorktreeBlock[],
  branch: string,
): WorktreeBlock | undefined =>
  blocks.find((b) => !b.detached && b.branch === branch);

// Pins the worktree to a known branch: the session header derives its branch
// from the PR link, then reports the local checkout on that branch.
const resolveWorktreeByBranch = async (
  cwd: string,
  run: GitRunner,
  branch: string,
): Promise<GitInfo> => {
  const result = await run(["worktree", "list", "--porcelain"], cwd);
  if (result.exitCode !== 0) return {};
  const blocks = parseWorktreeList(result.stdout);
  const block = findWorktreeByBranch(blocks, branch);
  if (block === undefined) return {};
  const info: GitInfo = { worktree: block.path };
  if (!block.detached && block.branch !== undefined && block.branch !== "")
    info.branch = block.branch;
  return info;
};

// Like readGitInfo, never throws — a non-repo or a missing git binary both
// degrade to an empty GitInfo.
const readWorktreeByBranch = async (
  cwd: string,
  run: GitRunner = runGit,
  branch: string,
): Promise<GitInfo> => {
  try {
    return await resolveWorktreeByBranch(cwd, run, branch);
  } catch {
    return {};
  }
};

export type { GitRunner };
export { readGitInfo, readWorktreeByBranch };
