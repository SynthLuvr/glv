# ADR 0008: Suggested next prompts via session-free helper asks

- Status: Accepted
- Date: 2026-10-12
- Deciders: glv maintainers

## Context

When a session finishes a turn, the natural next prompt is usually
obvious from what just happened. Asking the assistant for a few
follow-up suggestions costs a small amount of tokens and one background
process — but the ask must not disturb anything the user sees: no new
session in the sidebar, no transcript, no activity, and no slot in the
concurrency queue real prompts wait on.

The make-or-break question (verified empirically before anything was
built): can a behind-the-scenes ask stay invisible in both agents’
stores?

- **goose 1.53.0**: `goose run --no-session` still writes a
  `hidden`-type session row into goose’s sessions database (working dir
  = the run’s cwd). glv lists `user`-type sessions only, so the row
  never appears in the sidebar — but it would accumulate in goose’s
  database forever and show under `glv logs`.
- **claude 2.1.289**: `claude --print --no-session-persistence` writes
  no transcript at all (only an empty per-directory folder under the
  projects root, which glv never lists — it reads transcript files).

So the premise holds, with one cleanup obligation on the goose side.

## Proposal

### Storage: a viewer-owned `suggestions.db`

Following ADR 0004’s blueprint (a glv-owned SQLite database opened with
a busy timeout, created on first use):

- a `settings` table holding one key — `enabled` — the single opt-in
  switch, default off;
- a `suggestions` table with one row per session: the turn fingerprint
  the row answers and the parsed prompts (a JSON string array; empty
  means “asked, nothing usable came back”).

The row is keyed by a **turn fingerprint** — `updated_at` of the session
row plus its committed message count. A later turn can never produce the
same pair (messages only grow), and a settled transcript yields a stable
key, so the pair identifies one exact finished turn across polls,
refreshes, and restarts. A stored row only renders when its fingerprint
matches the session as it currently sits, which makes stale suggestions
impossible by construction.

### The watcher

A background interval (default 1 s) scans the runner registry — the same
source the status feed reads — for handles that just reached `completed`
with an empty pending queue. Chained prompts only settle in that state
once, when the whole chain finishes. Guards:

- the setting is read fresh each poll, so the toggle applies with no
  restart and “off” does none of this work at all;
- only `completed` asks — stopped and errored runs never do;
- cron-tagged sessions (scheduled jobs are automation) never ask;
- at most two asks in flight; beyond that, suggestions simply do not
  happen that turn — they never queue.

### The ask

Each ask is a **session-free run of the same binary the session uses** —
same sign-in, same setup, nothing to configure:

- goose: `goose run --no-session --output-format stream-json -i -`
  (prompt over stdin), then a sweep of every session row recorded
  against the glv-owned scratch working directory the ask ran in — the
  no-trace guarantee for the hidden row goose leaves behind.
- claude:
  `claude --print --no-session-persistence --permission-mode manual --output-format stream-json --verbose`
  — nothing is persisted, and `manual` denies any tool call a headless
  run could never approve, so the ask can only ever answer with text.

The ask never goes through the runner’s concurrency pool: it is its own
subprocess, so it cannot slow down or queue behind real work. It
receives a grounded but deliberately small context — the session’s
opening goal, a digest of the tail window’s tool activity (commands run,
files touched), the last tool failure when there was one, and the
conversation tail (last 12 messages, capped per message and in total,
cut at word boundaries) — plus a fixed instruction to reply with a JSON
array of three short prompts, each naming something concrete from that
context, pulling toward different next moves, and never generic chores.
The reply is parsed leniently (a fenced array is tolerated), validated,
deduplicated (near-paraphrases collapse; word-set Jaccard ≥ 0.6), capped
at three prompts of ≤120 characters, and stored — or, when nothing
usable comes back, stored as the empty marker so **the same finished
turn is never asked twice**, even across page refreshes. Every failure
path fails silently: suggestions are a bonus, never a new way to show an
error.

The model the asks use is configured in the same database, not a flag:
the `model` settings row holds one combined picker spelling
(“<agent>:<model value>”), read fresh per ask so an edit applies without
a restart. A pin that no longer resolves against the live catalogue
warns once and falls back to the agent’s own default. By default (unset
or blank) each agent answers on its own configured model — goose:
whatever its config resolves — because provider and model names are
user-specific.

### Delivery

The prompt bar renders the stored set for the current turn when idle
(server-side, so refreshes and busy/idle bar swaps carry it), and the
session’s SSE stream gained a `suggestions` event that reconciles on
connect and emits on change — the ask typically lands seconds after the
turn completes, while the user is reading results. Accepting a
suggestion fills the input, ready to edit or send; typing or Escape
stands the strip down until the next turn’s set arrives.

## Consequences

- Helper asks are invisible end to end for both agents — proven by
  integration suites that complete a real turn through a real serve
  process and assert the store stays clean (no sidebar entry, no hidden
  goose row, no claude transcript).
- goose’s database grows nothing: every hidden row the ask creates is
  swept the moment the ask finishes.
- One more glv-owned database to back up alongside its siblings.
- Suggestions only follow glv-driven turns: a turn that finished in a
  terminal while the server was down is never asked about (no handle was
  ever observed).
- If goose or claude later ship a native suggestion mechanism, the
  `EphemeralAsk` seam (one per flavor, in the flavor’s tree) is where a
  preferred source plugs in — nothing user-visible changes.
