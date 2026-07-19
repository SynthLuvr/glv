import { execa } from "execa";

type GitResult = { stdout: string; exitCode: number };

type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 5000;

// `reject: false` makes a non-zero exit a result; a missing binary or bad cwd
// still throws (caught by readGitInfo).
const runGit: GitRunner = async (args, cwd) => {
  const result = await execa("git", [...args], {
    cwd,
    reject: false,
    timeout: GIT_TIMEOUT_MS,
  });
  return { stdout: result.stdout, exitCode: result.exitCode ?? 1 };
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

const resolveGitInfo = async (
  cwd: string,
  run: GitRunner,
): Promise<GitInfo> => {
  const result = await run(["worktree", "list", "--porcelain"], cwd);
  if (result.exitCode !== 0) return {};
  const block = findWorktree(parseWorktreeList(result.stdout), cwd);
  if (block === undefined) return {};
  const info: GitInfo = { worktree: block.path };
  if (!block.detached && block.branch !== undefined && block.branch !== "")
    info.branch = block.branch;
  return info;
};

const readGitInfo = async (
  cwd: string,
  run: GitRunner = runGit,
): Promise<GitInfo> => {
  try {
    return await resolveGitInfo(cwd, run);
  } catch {
    return {};
  }
};

export type { GitInfo, GitRunner, WorktreeBlock };
export { findWorktree, parseWorktreeList, readGitInfo };
