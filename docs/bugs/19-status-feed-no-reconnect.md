# 19 — Status feed never reconnects after a permanent close

- **Severity:** LOW
- **Category:** Error-handling gap / EventSource lifecycle
- **Location:** src/scripts/sidebar.ts (lines ~306-312)
- **Status:** Open

## Summary

The /events/status EventSource is created once. Its error handler nulls
the reference when readyState becomes CLOSED, but nothing ever
reconnects, so the running/idle indicators stop updating for the rest of
the page session.

## Why it fails

connectStatusFeed is invoked only at module load. Transient drops keep
readyState CONNECTING (auto-reconnect), but a permanent close leaves the
reference null with no recovery path.

## Impact

Stale sidebar status indicators until the page is reloaded.

## Suggested fix

On a CLOSED error, re-run connectStatusFeed (optionally with backoff)
instead of just nulling the reference.
