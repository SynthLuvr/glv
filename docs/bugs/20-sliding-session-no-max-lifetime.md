# 20 — Sliding session has no absolute max lifetime

- **Severity:** LOW
- **Category:** Security / session management
- **Location:** src/auth/service.ts (lines 200-206); src/auth/middleware.ts (lines 33-37)
- **Status:** Open

## Summary
Every authenticated request re-extends the DB session expiry by a day and
re-issues the cookie. With no absolute cap, a stolen cookie stays alive
indefinitely while in use.

## Why it fails
isValidSession calls refreshSession on every request, and the middleware
re-sets the cookie on every valid request. There is no max-age bound distinct
from the sliding window.

## Impact
A compromised session is hard to kill; combined with requireUserVerification:
false (an intentional tradeoff) the exposure is wider.

## Suggested fix
Track a hard absolute expiry (created_at + N) in addition to the sliding
window, and stop refreshing once it passes.
