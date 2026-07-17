# 17 — gh repo list hard-capped at 100

- **Severity:** LOW
- **Category:** Functional limitation
- **Location:** src/gh.ts (line 90)
- **Status:** Open

## Summary
listRepos passes --limit 100, so users with more than 100 repositories
silently see only the first 100.

## Why it fails
The --paginate pattern used elsewhere (listBranches) is not applied here, and
there is no indication that results were truncated.

## Impact
Missing repos in the GitHub source picker; functional, not a crash.

## Suggested fix
Paginate, or surface a "showing first 100" hint when the cap is hit.
