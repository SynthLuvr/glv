# 18 — source-picker loadBranches stale-response race

- **Severity:** LOW
- **Category:** Race condition / missing request cancellation
- **Location:** src/scripts/source-picker.ts (lines 70-96, entry handleRepoChange line 98)
- **Status:** Open

## Summary
Each repo change fires a loadBranches fetch with no AbortController. If the
user commits repo A then repo B before A resolves, a late A response can
overwrite B's branch list.

## Why it fails
The fetch result is applied to the shared #gh-branches datalist
unconditionally, so the last response to arrive wins regardless of which repo
is currently selected.

## Impact
The branch field can show suggestions belonging to the wrong repository,
leading the user to pick a branch that does not exist in the selected repo
and a failed clone.

## Suggested fix
Track an in-flight AbortController (or a request token) per repo change and
abort/ignore superseded responses.
