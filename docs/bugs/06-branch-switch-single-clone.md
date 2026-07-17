# 06 — Branch switch fails after a single-branch clone

- **Severity:** MEDIUM
- **Category:** Logic error
- **Location:** src/gh.ts (clonePathFor line 49, clone flags line 153,
  runUpdate lines 163-177)
- **Status:** Open

## Summary

Clone paths are keyed only on owner/repo (no branch) and the clone uses
–single-branch, so reusing the path for a different branch fails at
checkout.

## Buggy code

    const clonePathFor = (owner, repo) => join(CLONE_ROOT, owner, repo); // no branch
    // clone:
    ["clone", "--branch", branch, "--single-branch", url, path]
    // later reuse for a DIFFERENT branch:
    ["checkout", [branch]]   // ref was never fetched -> fails

## Why it fails

materialise reuses an existing path via runUpdate when existsSync(path)
is true. But a –single-branch clone only fetched one branch, so git
checkout of any other branch errors with “pathspec … did not match”, and
runUpdate throws “git checkout failed”.

## Impact

Selecting a different branch for an already-cloned repo always fails,
even though the branch legitimately exists on the remote.

## Suggested fix

Either include the branch in clonePathFor (separate worktree per
branch), or switch runUpdate to fetch all refs / the specific branch
before checkout (e.g. git fetch origin <branch> then checkout).
