# 05 — Concurrent new-session race orphans a run

- **Severity:** MEDIUM
- **Category:** Race condition / silent failure / resource leak
- **Location:** src/server/routes/sessions.tsx (line 192); src/server/routes/github.tsx (line 108)
- **Status:** Open

## Summary
The boolean return value of rekey is discarded, so two simultaneous
new-session submissions for the same working directory silently collide,
orphaning a handle and leaking a goose process.

## Buggy code

    rekey(ctx.runner, tempKey, realId);   // return value (boolean) ignored

## Why it fails
Both requests share an identical "known" set, so both discover the SAME first
new session id and both call rekey(tempKey, realId). The first rekey succeeds;
the second overwrites the realId entry with its own handle, orphaning the
first handle and its separately spawned goose process. Both responses then
render the same session while a second goose session runs untracked.

## Impact
Leaked detached process, leaked registry handle (feeds bug 02), and a
confusing duplicate/ghost session in the database.

## Suggested fix
Check the rekey return value. If false, stop the orphaned run and surface a
clear error (or reconcile by polling for the second session id). A per
working-directory lock around the create-and-rekey sequence would also close
the window.
