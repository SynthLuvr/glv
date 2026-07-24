import { describe, expect, it } from "vitest";
import { parseWorktreeList } from "../git.js";

describe("parseWorktreeList", () => {
  it("parses a single worktree with a branch", () => {
    const out = [
      "worktree /home/u/repo",
      "HEAD 111aaaa",
      "branch refs/heads/main",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/home/u/repo", branch: "main", detached: false },
    ]);
  });

  it("strips the refs/heads/ prefix from the branch name", () => {
    const out = [
      "worktree /home/u/wt",
      "HEAD 222bbbb",
      "branch refs/heads/feat/widget",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/home/u/wt", branch: "feat/widget", detached: false },
    ]);
  });

  it("marks a detached HEAD worktree as detached with no branch", () => {
    const out = [
      "worktree /home/u/detached",
      "HEAD 333cccc",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/home/u/detached", branch: undefined, detached: true },
    ]);
  });

  it("parses multiple worktrees separated by blank lines", () => {
    const out = [
      "worktree /home/u/repo",
      "HEAD 111aaaa",
      "branch refs/heads/main",
      "",
      "worktree /home/u/wt",
      "HEAD 222bbbb",
      "branch refs/heads/feat-x",
      "",
      "worktree /home/u/detached",
      "HEAD 333cccc",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/home/u/repo", branch: "main", detached: false },
      { path: "/home/u/wt", branch: "feat-x", detached: false },
      { path: "/home/u/detached", branch: undefined, detached: true },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });

  it("flushes the final block even without a trailing blank line", () => {
    const out = [
      "worktree /home/u/repo",
      "HEAD 111aaaa",
      "branch refs/heads/main",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/home/u/repo", branch: "main", detached: false },
    ]);
  });
});
