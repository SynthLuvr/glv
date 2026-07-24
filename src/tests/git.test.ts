import { describe, expect, it } from "vitest";
import { type GitRunner, readGitInfo, readWorktreeByBranch } from "../git.js";

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
