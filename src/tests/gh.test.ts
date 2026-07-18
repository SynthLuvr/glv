import { describe, expect, it } from "vitest";
import { parseDefaultBranch, parseRepoList, parseSshUrl } from "../gh.js";

// --- parseRepoList --------------------------------------------------------

describe("parseRepoList", () => {
  it("parses and sorts repos newest-first", () => {
    const stdout = JSON.stringify([
      {
        nameWithOwner: "a/old",
        visibility: "PUBLIC",
        isFork: false,
        updatedAt: "2024-01-01T00:00:00Z",
        description: "old",
      },
      {
        nameWithOwner: "a/new",
        visibility: "PRIVATE",
        isFork: true,
        updatedAt: "2025-06-01T00:00:00Z",
        description: null,
      },
    ]);
    const result = parseRepoList(stdout);
    expect(result.map((r) => r.nameWithOwner)).toEqual(["a/new", "a/old"]);
    expect(result[0]).toMatchObject({
      visibility: "PRIVATE",
      isFork: true,
      description: null,
    });
  });

  it("drops entries without a nameWithOwner", () => {
    const stdout = JSON.stringify([
      { nameWithOwner: "a/keep", updatedAt: "2024-01-01T00:00:00Z" },
      { updatedAt: "2024-01-01T00:00:00Z" },
    ]);
    expect(parseRepoList(stdout).map((r) => r.nameWithOwner)).toEqual([
      "a/keep",
    ]);
  });

  it("returns [] for non-JSON stdout (update notice / help text)", () => {
    expect(parseRepoList("A new release of gh is available")).toEqual([]);
    expect(parseRepoList("")).toEqual([]);
  });

  it("returns [] when stdout is valid JSON but not an array", () => {
    expect(parseRepoList('{"not":"an array"}')).toEqual([]);
    expect(parseRepoList('"a string"')).toEqual([]);
  });
});

// --- parseDefaultBranch ---------------------------------------------------

describe("parseDefaultBranch", () => {
  it("reads the default branch name", () => {
    const stdout = JSON.stringify({ defaultBranchRef: { name: "develop" } });
    expect(parseDefaultBranch(stdout)).toBe("develop");
  });

  it('falls back to "main" for a null defaultBranchRef', () => {
    expect(parseDefaultBranch(JSON.stringify({ defaultBranchRef: null }))).toBe(
      "main",
    );
  });

  it('falls back to "main" for non-JSON stdout', () => {
    expect(parseDefaultBranch("usage: gh repo view ...")).toBe("main");
    expect(parseDefaultBranch("")).toBe("main");
  });
});

// --- parseSshUrl ----------------------------------------------------------

describe("parseSshUrl", () => {
  it("reads the sshUrl field", () => {
    const stdout = JSON.stringify({ sshUrl: "git@github.com:owner/repo.git" });
    expect(parseSshUrl(stdout)).toBe("git@github.com:owner/repo.git");
  });

  it("throws a structured error for non-JSON stdout", () => {
    expect(() => parseSshUrl("A new release of gh is available")).toThrow(
      /non-JSON/,
    );
  });

  it("throws when sshUrl is missing or not a string", () => {
    expect(() => parseSshUrl(JSON.stringify({}))).toThrow(
      /did not return an sshUrl/,
    );
    expect(() => parseSshUrl(JSON.stringify({ sshUrl: 42 }))).toThrow(
      /did not return an sshUrl/,
    );
  });
});
