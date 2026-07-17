# 02 — Unbounded memory: run registry and line buffer never trimmed

- **Severity:** HIGH
- **Category:** Resource leak / unbounded memory
- **Location:** src/runner/queue.ts (line 78 set, line 168 only delete);
  src/runner/spawn.ts (line 85)
- **Status:** Open

## Summary

Finished run handles are never evicted from runner.registry, and each
handle keeps its full captured output array forever. A long-running
server accumulates every session ever run until it runs out of memory.

## Buggy code

    // queue.ts:78 — every enqueue inserts; no eviction on terminal status
    runner.registry.set(key, handle);
    // the only delete is in rekey(), which immediately re-adds the handle

    // spawn.ts:85 — appended forever, never sliced or capped
    handle.lines.push(line);

## Why it fails

status.ts only filters terminal handles out of the sidebar view; nothing
deletes them. A grep of the whole tree confirms there is no eviction
path. Each InternalHandle retains its lines array (all NDJSON output,
potentially megabytes per verbose session), callbacks, and prompt
history.

## Impact

Monotonic memory growth -\> eventual OOM on any long-lived server. The
poll-for-session-id timeout paths (sessions.tsx, github.tsx) and the
cloneJobs leak (see 11) all feed extra waste into this same registry.

## Suggested fix

- Evict a handle from the registry shortly after it reaches a terminal
  status AND any live SSE stream has drained it (e.g. a short retention
  timer or eviction once streams detach).
- Cap handle.lines to a ring buffer / max length instead of growing it
  without bound; live streams already track a sent offset so a bounded
  replay window suffices.
