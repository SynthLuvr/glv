import { describe, expect, it } from "vitest";
import { parseDefaultBranch, parseRepoList, parseSshUrl } from "../gh.js";

// --- parseRepoList --------------------------------------------------------

describe("parseRepoList", () => {
  // listRepos streams one JSON object per line (JSONL) from
  // `gh api ... --paginate --jq`, projecting these five fields per repo.
  const repoLine = (r: {
    nameWithOwner: string;
    visibility?: string;
    isFork?: boolean;
    updatedAt: string;
    description?: string | null;
  }): string =>
    JSON.stringify({
      nameWithOwner: r.nameWithOwner,
      visibility: r.visibility ?? "public",
      isFork: r.isFork ?? false,
      updatedAt: r.updatedAt,
      description: r.description ?? null,
    });

  it("parses JSONL repos and sorts newest-first", () => {
    const stdout = [
      repoLine({
        nameWithOwner: "a/old",
        visibility: "public",
        updatedAt: "2024-01-01T00:00:00Z",
        description: "old",
      }),
      repoLine({
        nameWithOwner: "a/new",
        visibility: "private",
        isFork: true,
        updatedAt: "2025-06-01T00:00:00Z",
        description: null,
      }),
    ].join("\n");
    const result = parseRepoList(stdout);
    expect(result.map((r) => r.nameWithOwner)).toEqual(["a/new", "a/old"]);
    expect(result[0]).toMatchObject({
      visibility: "PRIVATE",
      isFork: true,
      description: null,
    });
    expect(result[1]).toMatchObject({ visibility: "PUBLIC", isFork: false });
  });

  it("normalises lowercase REST visibility to upper-case", () => {
    const stdout = [
      repoLine({
        nameWithOwner: "a/pub",
        visibility: "public",
        updatedAt: "2024-01-01T00:00:00Z",
      }),
      repoLine({
        nameWithOwner: "a/priv",
        visibility: "private",
        updatedAt: "2024-01-02T00:00:00Z",
      }),
    ].join("\n");
    const byName = Object.fromEntries(
      parseRepoList(stdout).map((r) => [r.nameWithOwner, r.visibility]),
    );
    expect(byName).toEqual({ "a/pub": "PUBLIC", "a/priv": "PRIVATE" });
  });

  it("parses many repos across paginated output, ignoring blank lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++)
      lines.push(
        repoLine({
          nameWithOwner: `a/r${i}`,
          updatedAt: `2024-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      );
    // gh --paginate can emit a trailing/blank line between pages.
    const stdout = `${lines.join("\n")}\n\n`;
    expect(parseRepoList(stdout)).toHaveLength(250);
  });

  it("drops entries without a nameWithOwner", () => {
    const stdout = [
      JSON.stringify({
        nameWithOwner: "a/keep",
        updatedAt: "2024-01-01T00:00:00Z",
      }),
      JSON.stringify({ updatedAt: "2024-01-01T00:00:00Z" }),
    ].join("\n");
    expect(parseRepoList(stdout).map((r) => r.nameWithOwner)).toEqual([
      "a/keep",
    ]);
  });

  it("returns [] for non-JSON stdout (update notice / help text)", () => {
    expect(parseRepoList("A new release of gh is available")).toEqual([]);
    expect(parseRepoList("")).toEqual([]);
  });

  it("returns [] for a single JSON value that is not a repo object", () => {
    expect(parseRepoList('{"not":"a repo"}')).toEqual([]);
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
