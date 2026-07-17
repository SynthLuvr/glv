# 12 — Tail SSE never terminates on session deletion

- **Severity:** LOW
- **Category:** Resource leak / missing terminal handling
- **Location:** src/server/routes/stream.ts (lines 86-124)
- **Status:** Open

## Summary

If the session is deleted while a tail connection is open, the handler
keeps polling the database forever and never emits a terminal event.

## Why it fails

On deletion listMessages returns \[\], rows.length equals
snapshots.length, changed stays false, and the loop continues. The
getSession === undefined case is handled with “continue” instead of
closing the stream. With maxTailPolls defaulting to Infinity the
connection leaks until the client disconnects.

## Impact

Wasted per-second DB queries and a held connection per
deleted-while-open session.

## Suggested fix

When getSession returns undefined, emit a done/close event and return so
the client tears down its EventSource.
