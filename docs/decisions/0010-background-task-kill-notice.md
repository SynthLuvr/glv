# Decision 0010: surface claude’s background-task kills as stop notices

Date: 2026-10-29

## Status

Accepted.

## Context

Session `claude:5695cf75` ended “prematurely” — its last words were “CI
is running again on PR \#394. I’ll report back when it finishes” — yet
glv recorded a clean finish (`state=finished`, empty reason, no stop
notice), and the report-back never came.

Forensics on the transcript, the run history, and claude’s own
background-task files (`…/tasks/<id>.output`, stamped `[killed]` at the
process-exit moment) established the mechanism, verified against
controlled `claude 2.1.289 --print` runs:

- In headless `--print` mode, a pending **Monitor** task parks the
  process after the turn ends and delivers its events as new turns —
  that worked all morning in the same session.
- A plain **background Bash** task (`run_in_background`) gets no such
  treatment: once the terminal result record is printed and no monitor
  is pending, claude kills the task (~6 s grace observed), streams
  `system/task_notification` with `status:"stopped"`, and exits 0.

The agent had stopped its Monitor to re-arm the CI watch, re-armed it as
a plain background Bash, and ended its turn. claude killed the watcher
and exited cleanly; the runner, seeing exit 0 and no refusal record,
settled the run as finished. Nothing told the user the session had just
broken its last promise — the exact silent-stop shape [ADR
0009](0009-stop-notices-sidecar.md) exists to prevent, one provider
refusal short of the same blind spot.

## Decision

1.  **Classify the kill epilogue as a stop notice.**
    `src/glv/stop-reason.ts` already scans each run’s trailing stream
    lines; it now also recognizes claude’s kill records
    (`system/task_notification`, `status:"stopped"`) newer than the
    newest `result` record, and words a fourth notice kind: “pending
    background tasks were killed when the run ended”, naming the killed
    task’s summary. The result-record guard keeps a mid-run `TaskStop`
    (an ordinary monitoring handoff) from flagging a later clean finish,
    and announced refusals still outrank the epilogue. Persistence,
    clearing on continue, and the prompt-bar card come free via the
    existing notice plumbing.

2.  **Teach the agent not to arm doomed watchers.** The shared system
    prompt glv injects into every run (`--append-system-prompt`) now
    states the lifetime rule: a turn ends with the process, plain
    background jobs die with it and can never wake the agent, and
    cross-turn watches belong in the mechanism built to survive idle
    turns (claude’s Monitor tool).

## Alternatives considered

- **Keep the process alive across turns** (hold stdin open in
  stream-json input mode) — rejected for now: it changes the run model
  for every flavor to work around one agent’s task semantics, and
  whether claude then delivers background-task wakes without a monitor
  is unverified. Revisit if the kill epilogue stays noisy.
- **Auto-resume the session with a “your watcher was killed” prompt** —
  rejected: spends the user’s tokens to paper over the agent’s mistake
  and risks loops; the user decides, as with refusals.
- **Suppress the notice when the killed task looks intentional** (a dev
  server left running) — rejected: there is no reliable signal, and the
  notice is honest in both cases — work the agent left pending really
  was destroyed, and in glv’s one-process-per-prompt model it would not
  have survived to the next prompt regardless.

## Consequences

- An exit-0 run that killed pending background work now settles as
  `error` with a persisted notice instead of a silent clean finish — the
  same status shift a refusal already causes.
- The classifier keys on claude’s `system/task_notification` record; a
  claude version that changes or drops the epilogue quietly disables the
  notice (the system-prompt guidance remains).
- goose streams carry no such record, so the kind only ever fires for
  claude; the shared suite gates the scenario on the flavor fixture.
