import { describe, expect, it } from "vitest";
import { type GitRunner, readGitInfo, readWorktreeByBranch } from "../git.js";

// --- porcelain helpers ----------------------------------------------------

const block = (
  path: string,
  opts: { branch?: string; detached?: boolean } = {},
): string => {
  const lines = [`worktree ${path}`];
  if (opts.detached) lines.push("detached");
  else if (opts.branch !== undefined)
    lines.push(`branch refs/heads/${opts.branch}`);
  return lines.join("\n");
};

const porcelain = (
  blocks: { path: string; branch?: string; detached?: boolean }[],
): string => blocks.map((b) => block(b.path, b)).join("\n\n");

// --- readGitInfo ----------------------------------------------------------

const mockRunner =
  (stdout: string, exitCode = 0): GitRunner =>
  async () => ({ stdout, exitCode });

describe("readGitInfo", () => {
  it("returns the branch and worktree of the matching block", async () => {
    const out = porcelain([
      { path: "/repo", branch: "main" },
      { path: "/repo-feat", branch: "feat/git-info" },
    ]);
    expect(await readGitInfo("/repo-feat", mockRunner(out))).toEqual({
      branch: "feat/git-info",
      worktree: "/repo-feat",
    });
  });

  it("omits the branch but keeps the worktree for a detached HEAD", async () => {
    const out = block("/repo", { detached: true });
    expect(await readGitInfo("/repo", mockRunner(out))).toEqual({
      worktree: "/repo",
    });
  });

  it("resolves against a subdirectory, reporting the worktree root", async () => {
    const out = block("/repo", { branch: "main" });
    expect(await readGitInfo("/repo/src/lib", mockRunner(out))).toEqual({
      branch: "main",
      worktree: "/repo",
    });
  });

  it("returns an empty object when git fails (not a repo)", async () => {
    expect(
      await readGitInfo("/nope", mockRunner("fatal: not a repository", 128)),
    ).toEqual({});
  });

  it("returns an empty object when no worktree matches the cwd", async () => {
    const out = porcelain([{ path: "/elsewhere", branch: "main" }]);
    expect(await readGitInfo("/repo", mockRunner(out))).toEqual({});
  });

  it("never throws when the runner rejects", async () => {
    const failing: GitRunner = async () => {
      throw new Error("spawn failed");
    };
    expect(await readGitInfo("/repo", failing)).toEqual({});
  });
});

describe("readGitInfo with candidate paths", () => {
  it("recovers the worktree a session worked in when launched from another", async () => {
    const out = porcelain([
      { path: "/main", branch: "main" },
      { path: "/feat", branch: "feat/git-info" },
    ]);
    expect(
      await readGitInfo("/main", mockRunner(out), ["/feat/src/x.ts"]),
    ).toEqual({ branch: "feat/git-info", worktree: "/feat" });
  });

  it("falls back to the launch worktree when candidates only match it", async () => {
    const out = porcelain([
      { path: "/main", branch: "main" },
      { path: "/feat", branch: "feat/git-info" },
    ]);
    expect(
      await readGitInfo("/main", mockRunner(out), ["/main/src/x.ts"]),
    ).toEqual({ branch: "main", worktree: "/main" });
  });

  it("falls back to the launch worktree when no candidate matches", async () => {
    const out = porcelain([{ path: "/main", branch: "main" }]);
    expect(
      await readGitInfo("/main", mockRunner(out), ["/elsewhere/x"]),
    ).toEqual({ branch: "main", worktree: "/main" });
  });
});

describe("readWorktreeByBranch", () => {
  it("returns the worktree checked out on the given branch", async () => {
    const out = porcelain([
      { path: "/main", branch: "main" },
      { path: "/feat", branch: "feat/git-info" },
    ]);
    expect(
      await readWorktreeByBranch("/main", mockRunner(out), "feat/git-info"),
    ).toEqual({ branch: "feat/git-info", worktree: "/feat" });
  });

  it("returns an empty object when no worktree is on the branch", async () => {
    const out = porcelain([{ path: "/main", branch: "main" }]);
    expect(
      await readWorktreeByBranch("/main", mockRunner(out), "missing"),
    ).toEqual({});
  });

  it("ignores a detached worktree (no branch to match)", async () => {
    const out = block("/main", { detached: true });
    expect(
      await readWorktreeByBranch("/main", mockRunner(out), "main"),
    ).toEqual({});
  });

  it("returns an empty object when git fails (not a repo)", async () => {
    expect(
      await readWorktreeByBranch(
        "/nope",
        mockRunner("fatal: not a repository", 128),
        "main",
      ),
    ).toEqual({});
  });

  it("never throws when the runner rejects", async () => {
    const failing: GitRunner = async () => {
      throw new Error("spawn failed");
    };
    expect(await readWorktreeByBranch("/main", failing, "main")).toEqual({});
  });
});
