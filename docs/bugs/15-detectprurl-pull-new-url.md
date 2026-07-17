# 15 — detectPrUrl can return a non-PR pull/new URL

- **Severity:** LOW
- **Category:** Logic error
- **Location:** src/pr.ts (lines 75-78 consume, 114-116 rank)
- **Status:** Open

## Summary

A github.com/…/pull/new/<branch> URL is an invitation to create a PR,
not an existing PR. It is the lowest-ranked candidate but can still win
and be shown as the session’s PR.

## Why it fails

pushLink is collected from git push “remote:” lines and returned by
detectPrUrl only when no higher-ranked candidate exists. Downstream
resolvePrState then runs gh pr view on it -\> “unknown”, and prLabel
falls back to the literal “PR”.

## Impact

The UI can present a non-PR as the session’s PR. Not a crash, just a
misleading chip.

## Suggested fix

Treat pull/new URLs as hints only (e.g. show a “Create PR” affordance)
and never as the detected PR URL.
