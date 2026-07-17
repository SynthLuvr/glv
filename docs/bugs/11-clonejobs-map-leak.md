# 11 — cloneJobs map leaks when never polled

- **Severity:** LOW
- **Category:** Resource leak / unbounded memory
- **Location:** src/server/routes/sessions.tsx (line 134);
  src/server/context.ts (line 68)
- **Status:** Open

## Summary

A GitHub CloneJob is added to ctx.cloneJobs on every GitHub-mode
submission and removed only inside the clone-status poll handler. If the
user navigates away, the job (and its background goose run) is retained
forever.

## Why it fails

Cleanup lives solely in the /github/clone-status/:jobId route
(github.tsx). Abandoned jobs never reach a terminal cleanup; each also
holds a Set of known session ids and, via the runner, compounds the
registry leak in bug 02.

## Impact

Slow unbounded growth of the cloneJobs map over the server lifetime.

## Suggested fix

Add a TTL/retention sweep for cloneJobs, or delete the job when the
background runCloneJob promise settles regardless of polling.
