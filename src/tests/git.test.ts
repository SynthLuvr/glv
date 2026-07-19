import { describe, expect, it } from "vitest";
import {
  findWorktree,
  type GitRunner,
  parseWorktreeList,
  readGitInfo,
  selectWorktreeByPaths,
} from "../git.js";

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

// --- parseWorktreeList ----------------------------------------------------

describe("parseWorktreeList", () => {
  it("parses the path and checked-out branch of a worktree", () => {
    expect(parseWorktreeList(block("/repo", { branch: "main" }))).toEqual([
      { path: "/repo", branch: "main", detached: false },
    ]);
  });

  it("parses multiple blank-line-separated blocks", () => {
    const out = porcelain([
      { path: "/repo", branch: "main" },
      { path: "/repo-wt", branch: "feat/git" },
    ]);
    expect(parseWorktreeList(out)).toHaveLength(2);
    expect(parseWorktreeList(out)[1]).toEqual({
      path: "/repo-wt",
      branch: "feat/git",
      detached: false,
    });
  });

  it("strips the refs/heads/ prefix, keeping slashy branch names", () => {
    expect(
      parseWorktreeList(block("/r", { branch: "feature/x" }))[0].branch,
    ).toBe("feature/x");
  });

  it("marks a detached-HEAD block and leaves the branch undefined", () => {
    expect(parseWorktreeList(block("/repo", { detached: true }))).toEqual([
      { path: "/repo", branch: undefined, detached: true },
    ]);
  });

  it("handles output without a trailing blank line", () => {
    const out = "worktree /repo\nbranch refs/heads/main";
    expect(parseWorktreeList(out)).toEqual([
      { path: "/repo", branch: "main", detached: false },
    ]);
  });
});

// --- findWorktree ---------------------------------------------------------

describe("findWorktree", () => {
  const blocks = parseWorktreeList(
    porcelain([
      { path: "/repo", branch: "main" },
      { path: "/repo-wt", branch: "feat" },
    ]),
  );

  it("matches a working directory equal to a worktree root", () => {
    expect(findWorktree(blocks, "/repo-wt")?.path).toBe("/repo-wt");
  });

  it("matches a subdirectory to its worktree root", () => {
    expect(findWorktree(blocks, "/repo/src/lib")?.path).toBe("/repo");
  });

  it("prefers the deepest (most specific) enclosing worktree", () => {
    const nested = parseWorktreeList(
      porcelain([
        { path: "/repo", branch: "main" },
        { path: "/repo/wt", branch: "feat" },
      ]),
    );
    expect(findWorktree(nested, "/repo/wt/sub")?.path).toBe("/repo/wt");
  });

  it("returns undefined when no worktree contains the directory", () => {
    expect(findWorktree(blocks, "/elsewhere")).toBeUndefined();
  });
});

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

describe("selectWorktreeByPaths", () => {
  const blocks = parseWorktreeList(
    porcelain([
      { path: "/main", branch: "main" },
      { path: "/feat", branch: "feat" },
    ]),
  );

  it("returns the worktree enclosing the first matching path", () => {
    expect(selectWorktreeByPaths(blocks, ["/feat/src/a.ts"])?.path).toBe(
      "/feat",
    );
  });

  it("prefers the most recent matching path", () => {
    expect(selectWorktreeByPaths(blocks, ["/feat/y", "/main/x"])?.path).toBe(
      "/feat",
    );
  });

  it("skips the launch worktree in favour of a worked-in one", () => {
    expect(
      selectWorktreeByPaths(blocks, ["/main/x", "/feat/y"], "/main")?.path,
    ).toBe("/feat");
  });

  it("returns undefined when every candidate is the excluded worktree", () => {
    expect(selectWorktreeByPaths(blocks, ["/main/x"], "/main")).toBeUndefined();
  });

  it("returns undefined when no candidate matches a worktree", () => {
    expect(selectWorktreeByPaths(blocks, ["/elsewhere"])).toBeUndefined();
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
