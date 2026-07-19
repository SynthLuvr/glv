import { execa } from "execa";

type GitResult = { stdout: string; exitCode: number };

// Low-level runner so tests inject a fake without touching the filesystem.
type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 5000;

// `reject: false` turns a non-zero exit into a result; a missing binary or a
// non-existent cwd still throws (caught by readGitInfo).
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

// `git worktree list --porcelain` emits blank-line-separated blocks, each
// opening with `worktree <path>` and carrying `branch refs/heads/<name>`
// (or a bare `detached` line). A single call yields both the worktree
// directory and the branch checked out in it — no second transcript scan
// is needed.
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

// The session may run in a subdirectory of a worktree, so match the deepest
// (most specific) worktree path that contains the working directory.
const findWorktree = (
  blocks: readonly WorktreeBlock[],
  cwd: string,
): WorktreeBlock | undefined => {
  const matches = blocks
    .filter((b) => cwd === b.path || cwd.startsWith(`${b.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0];
};

const readGitInfo = async (
  cwd: string,
  run: GitRunner = runGit,
): Promise<GitInfo> => {
  try {
    const result = await run(["worktree", "list", "--porcelain"], cwd);
    if (result.exitCode !== 0) return {};
    const block = findWorktree(parseWorktreeList(result.stdout), cwd);
    if (block === undefined) return {};
    const info: GitInfo = { worktree: block.path };
    if (!block.detached && block.branch !== undefined && block.branch !== "")
      info.branch = block.branch;
    return info;
  } catch {
    return {};
  }
};

export type { GitInfo, GitResult, GitRunner, WorktreeBlock };
export { findWorktree, parseWorktreeList, readGitInfo };
