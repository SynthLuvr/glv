# Bug Findings — goose-log-viewer

One markdown file per bug found during the extensive static review. Each
file records severity, category, exact location, a focused code snippet,
the failure mechanism, impact, and a suggested fix.

## Index

### HIGH — fix soon

- [01 — Stored XSS via malicious git branch
  name](01-stored-xss-branch-name-innerhtml.md) —
  scripts/source-picker.ts
- [02 — Unbounded memory: run registry and line buffer never
  trimmed](02-memory-leak-registry-and-lines.md) — runner
- [03 — Path traversal in GitHub clone
  path](03-path-traversal-clone-path.md) — gh.ts

### MEDIUM — real defects

- [04 — No SIGKILL escalation; a stuck run can hang
  forever](04-no-sigkill-escalation.md) — runner/spawn.ts
- [05 — Concurrent new-session race orphans a
  run](05-concurrent-new-session-race.md) — routes/sessions.tsx
- [06 — Branch switch fails after a single-branch
  clone](06-branch-switch-single-clone.md) — gh.ts
- [07 — Shutdown aborts in-flight requests and leaks
  resources](07-shutdown-inflight-and-leak.md) — commands/serve.ts
- [08 — Auth verify routes throw on malformed
  JSON](08-auth-verify-malformed-json.md) — routes/auth.tsx
- [09 — WebAuthn single shared challenge
  slot](09-webauthn-shared-challenge-slot.md) — auth/service.ts
- [10 — GitHub error routes return HTTP
  200](10-github-error-routes-return-200.md) — routes/github.tsx

### LOW — minor

- [11 — cloneJobs map leaks when never polled](11-clonejobs-map-leak.md)
- [12 — Tail SSE never terminates on session
  deletion](12-tail-sse-no-terminate-on-delete.md)
- [13 — Expired auth sessions are never
  purged](13-expired-sessions-never-purged.md)
- [14 — Unguarded JSON.parse in gh.ts](14-unguarded-json-parse-gh.md)
- [15 — detectPrUrl can return a non-PR pull/new
  URL](15-detectprurl-pull-new-url.md)
- [16 — pid ?? -1 fallback can signal PID
  1](16-pid-fallback-kill-init.md)
- [17 — gh repo list hard-capped at 100](17-gh-repo-list-capped-100.md)
- [18 — source-picker loadBranches stale-response
  race](18-source-picker-stale-response-race.md)
- [19 — Status feed never reconnects after permanent
  close](19-status-feed-no-reconnect.md)
- [20 — Sliding session has no absolute max
  lifetime](20-sliding-session-no-max-lifetime.md)

### Informational — reviewed, not practically exploitable

- [21 — Lost stop() race window (latent
  only)](21-lost-stop-race-not-exploitable.md)

Severity legend: HIGH = fix soon; MEDIUM = real defect; LOW = minor;
Informational = analyzed and judged non-exploitable in the current code.
