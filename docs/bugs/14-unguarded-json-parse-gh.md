# 14 — Unguarded JSON.parse in gh.ts

- **Severity:** LOW
- **Category:** Error-handling gap
- **Location:** src/gh.ts (lines 69, 108, 138)
- **Status:** Open

## Summary
gh.ts parses gh command stdout with bare JSON.parse. If gh exits 0 but prints
non-JSON (an update notice, a warning, unauthenticated help text), it throws
an opaque SyntaxError.

## Why it fails
Unlike pr.ts, which wraps JSON.parse in try/catch (parseGhState,
prUrlFromJson), gh.ts assumes stdout is always JSON. execa uses reject:true
here so a non-zero exit throws first, but exit-0-with-non-JSON is unhandled.

## Impact
Confusing low-level errors surfaced to the user instead of a structured
message.

## Suggested fix
Wrap each parse in try/catch and return a typed error / empty result.
