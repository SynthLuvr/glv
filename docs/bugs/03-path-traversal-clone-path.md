# 03 — Path traversal in GitHub clone path

- **Severity:** MEDIUM-HIGH (HIGH if the viewer is exposed on a network)
- **Category:** Security / path traversal
- **Location:** src/gh.ts (parseOwnerRepo, clonePathFor, materialise)
- **Status:** Open

## Summary

The clone target directory is derived from user input with path.join,
which normalizes .. segments. A crafted repository string escapes the
/tmp/glv sandbox to an arbitrary absolute path.

## Buggy code

    const clonePathFor = (owner, repo) => join("/tmp/glv", owner, repo);

    const parseOwnerRepo = (repo) => {
      const trimmed = repo.trim();
      const slash = trimmed.indexOf("/");
      if (slash <= 0 || slash === trimmed.length - 1) throw ...;
      return { owner: trimmed.slice(0, slash), repo: trimmed.slice(slash + 1) };
    };

## Why it fails

parseOwnerRepo only checks the position of the first slash; it never
inspects the content of owner or repo. Input “a/../../../etc” parses to
{ owner: “a”, repo: “../../../etc” }. path.join then resolves
/tmp/glv/a/../../../etc to /etc. Because /etc exists, materialise takes
the runUpdate branch (git fetch / checkout / pull with cwd set to the
traversed path) and never runs the gh repo view validation that only the
fresh-clone branch performs. The same path is later used as cwd for the
goose subprocess.

## Impact

An authenticated user can start goose (and manipulate git state) in an
arbitrary existing directory outside the intended clone root. Auth is
always enabled, but the passkey system implies network deployment is
supported.

## Suggested fix

Validate owner and repo against a strict allowlist (e.g. /[^1]+\$/)
before constructing the path, and/or assert that the resolved clonePath
starts with the CLONE_ROOT prefix after normalization.

[^1]: A-Za-z0-9.\_-
