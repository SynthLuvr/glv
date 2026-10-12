# Decision 0008: stop-early notices in a viewer-owned sidecar

Date: 2026-10-12

## Status

Accepted.

## Context

When a provider refuses to serve a session — a usage limit with a reset
time, a network outage — the agent announces it on its own NDJSON stream
and in its logs, then exits. goose 1.45.0 even exits 0 after printing
its `{"type":"error",...}` record. None of that announcement survives
anywhere the viewer reads:

- The refusal record never lands in the session transcript (goose prints
  it; it does not store it), so the committed view never shows it.
- The live preview drops it (it is not a message record).
- The in-memory run handle that *could* carry it is evicted ~30 s after
  the process exits, and dies with the server on restart.

The result is a session that looks like it finished normally. Users lose
tens of minutes waiting for an agent that already stopped (a real
incident cost 73 minutes and manual log forensics).

## Decision

Three pieces:

1.  **Classify, don’t parse exit codes.** `src/glv/stop-reason.ts`
    inspects the trailing NDJSON lines of each run for the agents’ own
    failure records (goose’s `error` event, claude’s `is_error` result)
    and words the notice by what the provider said — usage limit,
    network, or a plain provider error — keeping the provider’s text
    (reset time included) verbatim. A detected refusal marks the run
    `error` even on exit 0.

2.  **Persist only refusals, in a new glv-owned SQLite sidecar**
    (`stop-notices.db`, one row per session, `--stop-notices-db` /
    `GLV_STOP_NOTICES_DB` to relocate). The runner gains a run-end
    observer; serve records a notice when a run ended with a refusal and
    clears it when a run ends normally or a follow-up is enqueued
    (“continue” resolves the outage). Ordinary completions, manual
    stops, and genuine crashes keep today’s behavior exactly — their
    messages stay transient, because that is not the problem being
    solved.

3.  **Render it where run errors already live.** The prompt bar’s styled
    `.status-hint error` slot shows the live run’s message while the
    handle exists and the persisted notice afterwards; the SSE status
    payload re-delivers it to connected clients (the `error` field was
    already optional on every status).

## Alternatives considered

- **Retry or wait out the quota automatically** — rejected: informing
  the user is the whole job; they decide.
- **Persist in the agents’ own stores** — rejected: browsing is
  read-only against agent-owned data; viewer state lives in sidecars
  (same rule as rename/archive meta and cron tags).
- **Wait for the agents to record failures in the session itself** — the
  right long-term fix (upstream), but outside our control and it does
  not help sessions glv already ran. The sidecar keeps working either
  way; an upstream fix only adds a second source.
- **A distinct “refused” run status** — rejected: `error` already flows
  through the SSE contract, the feed, and the styled hint; a new status
  would touch every consumer to say the same thing.

## Consequences

- Sessions started outside glv are not covered yet (phase 2 of the
  proposal): a run glv did not launch cannot be classified from its
  stream. The sidecar is keyed by session id, so log-based backfill can
  populate it later.
- One more small SQLite file under the data directory, created on first
  `serve`.
- The notice trusts the agent’s own wording; a provider that changes its
  phrasing still shows an honest (if generic) provider-error notice.
