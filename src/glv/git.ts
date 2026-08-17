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

// Normalise separators to forward slashes so the prefix check works on
// Windows (git emits backslash paths there) as well as Unix.
const normalizePath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/\/+$/, "");

// A session may run in a subdirectory of a worktree, so pick the deepest
// (most specific) enclosing path.
const findWorktree = (
  blocks: readonly WorktreeBlock[],
  cwd: string,
): WorktreeBlock | undefined => {
  const target = normalizePath(cwd);
  return blocks
    .filter((b) => {
      const base = normalizePath(b.path);
      return target === base || target.startsWith(`${base}/`);
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
};

// The launch dir's enclosing worktree.
const resolveGitInfo = async (
  cwd: string,
  run: GitRunner,
): Promise<GitInfo> => {
  const blocks = await listWorktrees(cwd, run);
  if (blocks === undefined) return {};
  const launch = findWorktree(blocks, cwd);
  return launch === undefined ? {} : gitInfoFromBlock(launch);
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
const readGitInfo = (cwd: string, run: GitRunner = runGit): Promise<GitInfo> =>
  resolveGitInfo(cwd, run).catch((err) => {
    console.debug("[glv:git]", err);
    return {};
  });

const readWorktreeByBranch = (
  cwd: string,
  run: GitRunner = runGit,
  branch: string,
): Promise<GitInfo> =>
  resolveWorktreeByBranch(cwd, run, branch).catch((err) => {
    console.debug("[glv:git]", err);
    return {};
  });

// Never throws. Non-repos are skipped silently so plain directories stay
// quiet; any pull failure is warned but never blocks session creation.
// `--no-edit` avoids hanging on a merge commit editor prompt.
const pullRepo = async (
  cwd: string,
  run: GitRunner = runGit,
): Promise<void> => {
  const info = await readGitInfo(cwd, run);
  if (info.worktree === undefined) return;
  try {
    const result = await run(["pull", "--no-edit"], cwd);
    if (result.exitCode !== 0)
      console.warn(`git pull failed in ${cwd} (exit ${result.exitCode})`);
  } catch (err) {
    console.warn(`git pull failed in ${cwd}: ${String(err)}`);
  }
};

export type { GitRunner };
export { pullRepo, readGitInfo, readWorktreeByBranch };
