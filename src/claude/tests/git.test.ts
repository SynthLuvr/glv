import { describe, expect, it } from "vitest";
import {
  type GitRunner,
  pullRepo,
  readGitInfo,
  readWorktreeByBranch,
} from "../../glv/git.js";

// A fake GitRunner returning canned porcelain output so the parsing and
// lookup logic in git.ts can be exercised without a real repo.
const fakeRunner =
  (stdout: string, exitCode = 0): GitRunner =>
  async () => ({ stdout, exitCode });

const porcelain = (...lines: string[]): string => lines.join("\n");

describe("readGitInfo", () => {
  it("resolves the branch and worktree for a single worktree", async () => {
    const worktrees = porcelain("worktree /repo", "branch refs/heads/main");
    expect(await readGitInfo("/repo", fakeRunner(worktrees))).toEqual({
      branch: "main",
      worktree: "/repo",
    });
  });

  it("strips the refs/heads/ prefix from the branch name", async () => {
    const worktrees = porcelain(
      "worktree /repo",
      "branch refs/heads/feat/widget",
    );
    expect(await readGitInfo("/repo", fakeRunner(worktrees))).toEqual({
      branch: "feat/widget",
      worktree: "/repo",
    });
  });

  it("reports no branch for a detached HEAD worktree", async () => {
    const worktrees = porcelain("worktree /repo", "detached");
    expect(await readGitInfo("/repo", fakeRunner(worktrees))).toEqual({
      worktree: "/repo",
    });
  });

  it("picks the deepest enclosing worktree when multiple exist", async () => {
    const worktrees = porcelain(
      "worktree /repo",
      "branch refs/heads/main",
      "",
      "worktree /repo/sub",
      "branch refs/heads/sub-branch",
    );
    expect(await readGitInfo("/repo/sub", fakeRunner(worktrees))).toEqual({
      branch: "sub-branch",
      worktree: "/repo/sub",
    });
  });

  it("returns an empty object when not a git repo (non-zero exit)", async () => {
    expect(await readGitInfo("/nope", fakeRunner("", 128))).toEqual({});
  });

  it("returns an empty object when the runner throws", async () => {
    const bomb: GitRunner = async () => {
      throw new Error("git not found");
    };
    expect(await readGitInfo("/nope", bomb)).toEqual({});
  });

  it("matches a worktree path that uses backslash separators", async () => {
    const worktrees = porcelain("worktree C:\\repo", "branch refs/heads/main");
    expect(await readGitInfo("C:\\repo", fakeRunner(worktrees))).toEqual({
      branch: "main",
      worktree: "C:\\repo",
    });
  });

  it("matches a subdirectory under a backslash worktree path", async () => {
    const worktrees = porcelain("worktree C:\\repo", "branch refs/heads/main");
    expect(await readGitInfo("C:\\repo\\sub", fakeRunner(worktrees))).toEqual({
      branch: "main",
      worktree: "C:\\repo",
    });
  });
});

describe("readWorktreeByBranch", () => {
  it("finds the worktree checked out on the given branch", async () => {
    const worktrees = porcelain(
      "worktree /repo",
      "branch refs/heads/main",
      "",
      "worktree /repo/wt",
      "branch refs/heads/feat-x",
    );
    expect(
      await readWorktreeByBranch("/repo", fakeRunner(worktrees), "feat-x"),
    ).toEqual({ branch: "feat-x", worktree: "/repo/wt" });
  });

  it("returns an empty object when the branch has no worktree", async () => {
    const worktrees = porcelain("worktree /repo", "branch refs/heads/main");
    expect(
      await readWorktreeByBranch("/repo", fakeRunner(worktrees), "missing"),
    ).toEqual({});
  });

  it("returns an empty object when not a git repo", async () => {
    expect(
      await readWorktreeByBranch("/nope", fakeRunner("", 128), "main"),
    ).toEqual({});
  });
});

describe("pullRepo", () => {
  // Routes `worktree` to canned porcelain, `pull` to a settable exit code.
  // Records all calls so order is assertable.
  const recordingRunner = (
    porcelainOut: string,
    repoExit = 0,
    pullExit = 0,
  ): { run: GitRunner; calls: string[][] } => {
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "worktree")
        return { stdout: porcelainOut, exitCode: repoExit };
      return { stdout: "", exitCode: pullExit };
    };
    return { run, calls };
  };

  it("pulls when cwd is inside a git worktree", async () => {
    const wt = porcelain("worktree /repo", "branch refs/heads/main");
    const { run, calls } = recordingRunner(wt);
    await pullRepo("/repo", run);
    expect(calls).toEqual([
      ["worktree", "list", "--porcelain"],
      ["pull", "--no-edit"],
    ]);
  });

  it("skips the pull when cwd is not a git repo", async () => {
    const { run, calls } = recordingRunner("", 128);
    await pullRepo("/nope", run);
    expect(calls).toEqual([["worktree", "list", "--porcelain"]]);
  });

  it("swallows a non-zero pull exit without throwing", async () => {
    const wt = porcelain("worktree /repo", "branch refs/heads/main");
    const { run } = recordingRunner(wt, 0, 1);
    await expect(pullRepo("/repo", run)).resolves.toBeUndefined();
  });

  it("swallows a thrown runner error without throwing", async () => {
    const wt = porcelain("worktree /repo", "branch refs/heads/main");
    const run: GitRunner = async (args) => {
      if (args[0] === "worktree") return { stdout: wt, exitCode: 0 };
      throw new Error("boom");
    };
    await expect(pullRepo("/repo", run)).resolves.toBeUndefined();
  });
});
