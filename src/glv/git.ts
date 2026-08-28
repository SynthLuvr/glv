import { realpathSync } from "node:fs";
import { platform } from "node:os";
import { mayFailAsync } from "ts-handling";
import { execGit } from "./shell.js";

type GitResult = { stdout: string; exitCode: number };

type GitRunner = (
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 5000;
// A pull is network I/O: fetch + merge legitimately takes tens of seconds on
// a slow remote, and a timeout SIGTERM landing mid-merge would strand the
// user's working tree in a conflicted state (MERGE_HEAD left behind).
const PULL_TIMEOUT_MS = 60_000;

// A non-repo (non-zero exit) or a missing git binary both degrade to an empty
// GitInfo — the former via the exit-code check, the latter caught by the
// read* wrappers below.
const runGit: GitRunner = async (args, cwd, timeoutMs = GIT_TIMEOUT_MS) => {
  const { stdout, exitCode } = await execGit(args, {
    cwd,
    timeoutMs,
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

// A stale worktree entry or a missing dir keeps the literal path.
const realPathOrSelf = (value: string): string => {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
};

// Git can report a different spelling of the same directory than the one
// stored on the session: on Windows the TEMP dir is routinely an 8.3 short
// path (C:\Users\RUNNE~1\...) while `git worktree list` resolves to the
// long form (C:/Users/runneradmin/...), so a plain string compare never
// matches. Canonicalise both sides — real path, forward slashes, no \\?\
// prefix, case-folded on Windows — before comparing.
const canonicalizePath = (value: string): string => {
  const forward = realPathOrSelf(value)
    .replace(/^\\\\\?\\UNC\\/, "//")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/");
  const cased = platform() === "win32" ? forward.toLowerCase() : forward;
  return cased.replace(/\/+$/, "");
};

// A session may run in a subdirectory of a worktree, so pick the deepest
// (most specific) enclosing path.
const findWorktree = (
  blocks: readonly WorktreeBlock[],
  cwd: string,
): WorktreeBlock | undefined => {
  const target = canonicalizePath(cwd);
  return blocks
    .filter((b) => {
      const base = canonicalizePath(b.path);
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

// The read* wrappers never throw: any failure (e.g. a missing git binary)
// degrades to an empty GitInfo, logged at debug level.
const degradeToEmpty = async (
  resolve: () => Promise<GitInfo>,
): Promise<GitInfo> => {
  const result = await mayFailAsync(resolve);
  if (!result.ok) console.debug("[glv:git]", result.error);
  return result.ok ? result.data : {};
};

const readGitInfo = (cwd: string, run: GitRunner = runGit): Promise<GitInfo> =>
  degradeToEmpty(() => resolveGitInfo(cwd, run));

const readWorktreeByBranch = (
  cwd: string,
  run: GitRunner = runGit,
  branch: string,
): Promise<GitInfo> =>
  degradeToEmpty(() => resolveWorktreeByBranch(cwd, run, branch));

// Never throws. Non-repos are skipped silently so plain directories stay
// quiet; any pull failure is warned but never blocks session creation.
// `--no-edit` avoids hanging on a merge commit editor prompt.
const pullRepo = async (
  cwd: string,
  run: GitRunner = runGit,
): Promise<void> => {
  const info = await readGitInfo(cwd, run);
  if (info.worktree === undefined) return;
  const result = await mayFailAsync(() =>
    run(["pull", "--no-edit"], cwd, PULL_TIMEOUT_MS),
  );
  if (!result.ok) {
    console.warn(`git pull failed in ${cwd}: ${result.error}`);
    return;
  }
  if (result.data.exitCode !== 0)
    console.warn(`git pull failed in ${cwd} (exit ${result.data.exitCode})`);
};

export type { GitRunner };
export { pullRepo, readGitInfo, readWorktreeByBranch };
