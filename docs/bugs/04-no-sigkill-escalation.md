# 04 — No SIGKILL escalation; a stuck run can hang forever

- **Severity:** MEDIUM
- **Category:** Resource leak / hang / error-handling gap
- **Location:** src/runner/spawn.ts (lines 83-90); src/runner/queue.ts (line 195)
- **Status:** Open

## Summary
Stopping a run sends a single SIGINT and then awaits the child exit. If goose
(or any tool child in its group) ignores SIGINT, the await never resolves and
the queue slot is held forever.

## Buggy code

    for await (const line of proc.stdout) {
      if (handle.status === "stopped") break;
      handle.lines.push(line);
      handle.onLine?.(line);
    }
    const result = await proc.exit;          // blocks until the child exits
    if (handle.status === "stopped") return;

    // queue.ts:195 — only SIGINT, never escalated
    handle.process.kill("SIGINT");

## Why it fails
There is no timeout-and-escalate path. A misbehaving or long-shutting-down
process leaves runProcess parked on await proc.exit, so advanceChain is
never reached and the handle is stuck in "stopped" while the process lives.
The concurrency slot is also consumed for good.

## Impact
One stubborn process can permanently block a runner slot and leak a detached
process group, degrading throughput over time.

## Suggested fix
After sending SIGINT, race proc.exit against a timeout; on timeout send
SIGTERM then SIGKILL (via the process group), and resolve runProcess so the
slot is released.
