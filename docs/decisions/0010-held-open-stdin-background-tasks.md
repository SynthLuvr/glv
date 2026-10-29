# Decision 0010: keep claude runs alive across background tasks

Date: 2026-10-29

## Status

Accepted.

## Context

Session `claude:5695cf75` ended “prematurely” — its last words were “CI
is running again on PR \#394. I’ll report back when it finishes” — yet
glv recorded a clean finish (`state=finished`, empty reason), and the
report-back never came.

Forensics on the transcript, the run history, and claude’s own
background-task files (`…/tasks/<id>.output`, stamped `[killed]` at the
process-exit moment) established the mechanism, verified against
controlled `claude 2.1.289 --print` runs:

- In headless `--print` mode, a pending **Monitor** task parks the
  process after the turn ends and delivers its events as new turns.
- A plain **background Bash** task (`run_in_background`) got no such
  treatment: once the terminal result record was printed with no monitor
  pending and stdin at EOF, claude killed the task (~6 s grace),
  streamed `system/task_notification` with `status:"stopped"`, and
  exited 0.

The agent had stopped its Monitor to re-arm the CI watch and re-armed it
as a plain background Bash — a perfectly reasonable choice in an
interactive session, fatal in glv’s headless one.

## Decision

**Hold claude’s stdin open for the lifetime of the run, in stream-json
input mode, and close it when the run has nothing left to wait for.** A
headless claude whose stdin is an open pipe treats the session as live —
the same contract an interactive terminal gets:

- pending background tasks survive the end of the turn that armed them
  (no kill epilogue, verified);
- a completed task wakes the agent into a new turn that ends with its
  own `result` record (verified);
- the process exits once stdin closes (verified), so glv — not claude —
  decides when the run ends.

Mechanically:

- claude’s invocation adds `--input-format stream-json`; the prompt
  travels as one JSON user-message line instead of raw text.
- The runner’s stdin contract generalizes to a **plan**: one-shot (write
  and close — goose, unchanged) or **held** (write and keep open, with a
  close policy). `SpawnedProcess` gains an idempotent `closeStdin`.
- The claude close policy (`src/claude/stdin-policy.ts`) reads the run’s
  own stream records: stdin closes at a `result` record when the latest
  `background_tasks_changed` snapshot is empty. A run with nothing
  pending settles exactly when it always did; a run with a pending
  watcher holds, the completion wakes a new turn, and *that* turn’s
  result re-evaluates the rule — so watchers that re-arm watchers keep
  the session alive indefinitely. Tasks that never complete (a dev
  server) park the run the way a Monitor task always has; the user stops
  it when they want it gone.
- A defensive idle window (`GLV_CLAUDE_STDIN_IDLE_MS`, default 15 s)
  closes stdin if a turn has ended with nothing pending and the stream
  then goes silent — bounding the park if a future claude ever completes
  a task without waking the agent.

**The kill epilogue stays classified as a stop notice.** With stdin
held, the epilogue should no longer occur in glv-driven runs; the
classifier in `src/glv/stop-reason.ts` remains as a tripwire for claude
drift — if a release re-introduces an exit-time kill, the user still
learns that pending work was destroyed instead of seeing a clean finish.

The shared system prompt now states the lifetime rule in its new form:
pending background work may keep the run alive and its completion may
wake the agent (true for claude in glv); if the runtime kills background
jobs at run end, finish or stop them before ending the turn.

## Verification

All against the real `claude 2.1.289` binary, exact glv argv
(`--session-id` / `--resume`, `--print`, `--output-format stream-json`,
`--verbose`, `--input-format stream-json`):

1.  Control (text stdin, closed): result → ~5 s later the kill epilogue
    (`task_updated` killed, `task_notification` stopped) → exit 0 — the
    incident reproduced.
2.  Held-open stdin: result at turn end → process stays alive, no kill;
    task completes → `background_tasks_changed` empties, wake turn runs
    (init → assistant → result) → process parked until stdin closed.
3.  Closing stdin at the moment the snapshot empties does **not** abort
    an in-flight wake turn — the turn completes, then the process exits
    on its own. EOF means “finish up and exit”, not “abort”.
4.  `--resume` with stream-json input works identically — follow-up
    prompts (one process per prompt, unchanged model) hold stdin too.
5.  `--session-id` is honoured alongside stream-json input; the wake
    chain works end to end on the new-session path.

## Alternatives considered

- **Surface the kill as a stop notice and teach the agent to use
  Monitor** (this ADR’s original form) — rejected on review: it tells
  the user about the destruction instead of not destroying the work. The
  agent’s choice (plain background Bash for a watch) is reasonable and
  matches interactive behavior; the host should honor it.
- **Auto-resume the session with a “your watcher was killed” prompt** —
  rejected: spends the user’s tokens and risks loops.
- **Hold stdin open with the text dialect** — impossible: text stdin
  needs EOF to delimit the prompt; the process would never start its
  turn. Stream-json input delimits per line, which is what makes the
  held-open pipe viable.

## Consequences

- claude runs may legitimately stay “running” for as long as the agent
  left background work pending — the same visibility an interactive user
  has — and hold a runner concurrency slot while parked (as
  Monitor-parked runs already did).
- The run’s stream now carries multiple `result` records when wake turns
  occur (Monitor wakes already produced this shape).
- goose is untouched (one-shot stdin, text dialect).
- A future claude that drops or renames the snapshot/result records
  would degrade to: never closing stdin eagerly → the idle defense
  closes it 15 s after the last record; the kill-notice tripwire covers
  any re-introduced exit epilogue.
