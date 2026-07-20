import { execGit } from "./shell.js";

type GitResult = { stdout: string; exitCode: number };

type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 5000;

// A non-repo (non-zero exit) or a missing git binary both degrade to an empty
// GitInfo — the former via the exit-code check, the latter caught by the
// read* wrappers below.
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

// Lists worktrees via porcelain output; `undefined` means not a git repo.
const listWorktrees = async (
  cwd: string,
  run: GitRunner,
): Promise<WorktreeBlock[] | undefined> => {
  const result = await run(["worktree", "list", "--porcelain"], cwd);
  return result.exitCode === 0 ? parseWorktreeList(result.stdout) : undefined;
};

// A detached HEAD has no branch name, so it is reported as worktree-only.
const gitInfoFromBlock = (block: WorktreeBlock): GitInfo => {
  const info: GitInfo = { worktree: block.path };
  if (block.branch !== undefined && block.branch !== "" && !block.detached)
    info.branch = block.branch;
  return info;
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

// The launch dir's enclosing worktree, or the one a session actually worked in
// when it `git worktree add`ed a second checkout and did all its work there.
const resolveGitInfo = async (
  cwd: string,
  run: GitRunner,
  paths: readonly string[] = [],
): Promise<GitInfo> => {
  const blocks = await listWorktrees(cwd, run);
  if (blocks === undefined) return {};
  const launch = findWorktree(blocks, cwd);
  const block = selectWorktreeByPaths(blocks, paths, launch?.path) ?? launch;
  return block === undefined ? {} : gitInfoFromBlock(block);
};

const findWorktreeByBranch = (
  blocks: readonly WorktreeBlock[],
  branch: string,
): WorktreeBlock | undefined => blocks.find((b) => b.branch === branch);

// The worktree checked out on a known branch (e.g. derived from a PR link).
const resolveWorktreeByBranch = async (
  cwd: string,
  run: GitRunner,
  branch: string,
): Promise<GitInfo> => {
  const blocks = await listWorktrees(cwd, run);
  if (blocks === undefined) return {};
  const block = findWorktreeByBranch(blocks, branch);
  return block === undefined ? {} : gitInfoFromBlock(block);
};

// Never throws — a missing git binary degrades to an empty GitInfo.
const readGitInfo = (
  cwd: string,
  run: GitRunner = runGit,
  paths: readonly string[] = [],
): Promise<GitInfo> => resolveGitInfo(cwd, run, paths).catch(() => ({}));

const readWorktreeByBranch = (
  cwd: string,
  run: GitRunner = runGit,
  branch: string,
): Promise<GitInfo> =>
  resolveWorktreeByBranch(cwd, run, branch).catch(() => ({}));

export type { GitRunner };
export { readGitInfo, readWorktreeByBranch };
