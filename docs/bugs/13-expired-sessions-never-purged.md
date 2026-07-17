# 13 — Expired auth sessions are never purged

- **Severity:** LOW
- **Category:** Unbounded growth
- **Location:** src/auth/db.ts (createSession line 165; deleteSession line 192)
- **Status:** Open

## Summary
Auth session rows are inserted on every login and removed only on explicit
logout. Expired rows are never garbage-collected.

## Why it fails
validSession filters by expires_at > datetime('now'), but nothing ever
deletes rows where expires_at has passed. The sessions table therefore grows
without bound over the process lifetime.

## Impact
Small for a single-user local app (logins are infrequent) but a genuine
unbounded-growth gap with no cleanup path.

## Suggested fix
Periodically (or on login) delete rows where expires_at <= datetime('now').
