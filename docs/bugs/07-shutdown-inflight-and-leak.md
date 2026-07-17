# 07 — Shutdown aborts in-flight requests and leaks resources

- **Severity:** MEDIUM
- **Category:** Error-handling gap / resource leak
- **Location:** src/commands/serve.ts (lines 35-41)
- **Status:** Open

## Summary

The shutdown handler calls server.close() and immediately
process.exit(0), aborting every in-flight request, never closing the
databases, and only reaping goose processes on SIGINT/SIGTERM (not on
crash or SIGKILL).

## Buggy code

    const shutdown = (): void => {
      stopAll(runner);
      server.close();        // async; stops accepting, does not drain
      process.exit(0);       // fires next tick -> kills in-flight requests
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

## Why it fails

Node’s http.Server.close only stops accepting new connections and
completes asynchronously; calling process.exit on the next tick aborts
active sockets. The session db and authDb (DatabaseSync) opened at lines
23-24 are never closed. Goose children are spawned detached, so any exit
path that skips stopAll (crash, OOM-kill, kill -9) leaves every live
goose process group running as an orphan.

## Impact

Truncated responses on shutdown; possible SQLite WAL/header issues from
unclosed handles; orphaned detached processes after abnormal
termination.

## Suggested fix

await server.close() inside an async shutdown, close both databases,
register an uncaughtException / beforeExit handler that also calls
stopAll, and consider calling proc.unref()/ref management so children do
not outlive a crashed parent.
