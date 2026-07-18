import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runClone, runUpdate } from "../gh.js";

// Builds a throwaway local repository with three branches whose working
// trees each carry a distinct marker file, then leaves HEAD on main.
const buildOrigin = async (dir: string): Promise<void> => {
  await execa("git", ["init", "-q", "-b", "main", dir]);
  await execa("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await execa("git", ["config", "user.name", "test"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "main-v1");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-qm", "main c1"], { cwd: dir });

  await execa("git", ["checkout", "-q", "-b", "develop"], { cwd: dir });
  writeFileSync(join(dir, "dev.txt"), "dev-v1");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-qm", "develop c1"], { cwd: dir });

  await execa("git", ["checkout", "-q", "-b", "feature/slash"], { cwd: dir });
  writeFileSync(join(dir, "sl.txt"), "slash-v1");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-qm", "slash c1"], { cwd: dir });

  await execa("git", ["checkout", "-q", "main"], { cwd: dir });
};

const headBranch = async (cwd: string): Promise<string> => {
  const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
  });
  return stdout.trim();
};

// Remote-tracking refs only (the symbolic origin/HEAD line is filtered out).
const remoteBranches = async (cwd: string): Promise<string[]> => {
  const { stdout } = await execa(
    "git",
    ["branch", "-r", "--format=%(refname:short)"],
    { cwd },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.includes("HEAD"));
};

let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "gh-clone-test-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("runClone", () => {
  it("produces a single-branch clone of the requested branch", async () => {
    const origin = join(base, "clone-origin");
    const work = join(base, "clone-work");
    await buildOrigin(origin);

    await runClone(origin, "main", work);

    // Only the cloned branch is present remotely; develop was never fetched.
    const refs = await remoteBranches(work);
    expect(refs).toContain("origin/main");
    expect(refs).not.toContain("origin/develop");
    expect(existsSync(join(work, "file.txt"))).toBe(true);
    expect(existsSync(join(work, "dev.txt"))).toBe(false);
    expect(await headBranch(work)).toBe("main");
  });

  it("throws when the branch does not exist on the remote", async () => {
    const origin = join(base, "clone-bad-origin");
    const work = join(base, "clone-bad-work");
    await buildOrigin(origin);

    await expect(runClone(origin, "nope", work)).rejects.toThrow();
  });
});

describe("runUpdate (branch switching after a single-branch clone)", () => {
  it("switches to a different branch that was never fetched", async () => {
    const origin = join(base, "switch-origin");
    const work = join(base, "switch-work");
    await buildOrigin(origin);
    await runClone(origin, "main", work);

    // A --single-branch clone never fetched develop, yet updating must land
    // on it. This is the regression: the old `git checkout develop` failed
    // with "pathspec 'develop' did not match".
    await runUpdate(work, "develop");

    expect(existsSync(join(work, "dev.txt"))).toBe(true);
    expect(readFileSync(join(work, "dev.txt"), "utf8")).toBe("dev-v1");
    expect(await headBranch(work)).toBe("develop");
  });

  it("switches to a branch whose name contains a slash", async () => {
    const origin = join(base, "slash-origin");
    const work = join(base, "slash-work");
    await buildOrigin(origin);
    await runClone(origin, "main", work);

    await runUpdate(work, "feature/slash");

    expect(readFileSync(join(work, "sl.txt"), "utf8")).toBe("slash-v1");
    expect(await headBranch(work)).toBe("feature/slash");
  });

  it("switches back to the original branch after switching away", async () => {
    const origin = join(base, "back-origin");
    const work = join(base, "back-work");
    await buildOrigin(origin);
    await runClone(origin, "main", work);
    await runUpdate(work, "develop");
    await runUpdate(work, "main");

    expect(existsSync(join(work, "dev.txt"))).toBe(false);
    expect(existsSync(join(work, "file.txt"))).toBe(true);
    expect(await headBranch(work)).toBe("main");
  });

  it("updates an already-cloned branch to the latest remote tip", async () => {
    const origin = join(base, "update-origin");
    const work = join(base, "update-work");
    await buildOrigin(origin);
    await runClone(origin, "develop", work);

    // Advance develop on the remote after the clone.
    await execa("git", ["checkout", "-q", "develop"], { cwd: origin });
    writeFileSync(join(origin, "dev2.txt"), "dev-v2");
    await execa("git", ["add", "."], { cwd: origin });
    await execa("git", ["commit", "-qm", "develop c2"], { cwd: origin });
    await execa("git", ["checkout", "-q", "main"], { cwd: origin });

    await runUpdate(work, "develop");

    expect(readFileSync(join(work, "dev2.txt"), "utf8")).toBe("dev-v2");
    expect(await headBranch(work)).toBe("develop");
  });

  it("throws when switching to a branch that does not exist", async () => {
    const origin = join(base, "update-bad-origin");
    const work = join(base, "update-bad-work");
    await buildOrigin(origin);
    await runClone(origin, "main", work);

    await expect(runUpdate(work, "ghost")).rejects.toThrow();
  });
});
