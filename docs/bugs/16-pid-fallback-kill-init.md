# 16 — pid ?? -1 fallback can signal PID 1

- **Severity:** LOW
- **Category:** Logic error / latent wrong-target signal
- **Location:** src/runner/spawn.ts (line 40; killProcessGroup lines 14-16)
- **Status:** Open

## Summary
If a spawned process ever lacked a pid, the -1 fallback would make the kill
helper signal process group / PID 1 (init) instead of being a no-op.

## Buggy code

    const pid = proc.pid ?? -1;
    const killProcessGroup = (pid, signal = "SIGINT") => {
      try { process.kill(-pid, signal); } catch { /* Already exited. */ }
    };

## Why it fails
With pid = -1, -pid becomes 1, so process.kill(1, signal) targets init. In
current execa the pid is assigned synchronously and a failed spawn throws
first, so the path is effectively unreachable today, but the fallback is a
latent foot-gun.

## Impact
Latent; would only matter if execa ever returned an undefined pid.

## Suggested fix
Guard pid > 0 before signalling (treat anything else as "nothing to kill"),
and document the assumption.
