# ADR 0005: Catch up missed cron runs on the next start

- Status: Accepted
- Date: 2026-09-09
- Deciders: glv maintainers

## Context

The schedule lives only inside the running `serve` process. When the
moment an occurrence should fire arrives while the process is not
running — machine rebooted, container restarted, laptop asleep, serve
crashed — the run was silently lost. Expired one-shots were even deleted
unfired at the next boot (“a missed moment stays missed”), and a paused
job skipped its occurrences with no record. Nothing about a fire
outlived the process: the `cron_jobs` table had no memory of when a job
last fired, and croner (10.x) offers no suspend/wake or overdue-trigger
support to lean on.

## Decision

An occurrence that came due while no scheduler was watching fires once,
when the scheduler next adopts a job set (boot **or** reload). The rule
is occurrence-based, not cause-based: it does not matter whether the
occurrence was missed because the process was down or because the job
was paused — *paused* means “not now”, not “never”.

### The rule

For every **enabled** job at adoption: if the schedule has an occurrence
`t` with `last_fired_at < t ≤ now`, fire once, immediately, serving the
**latest** such occurrence. However many occurrences were missed (a
month-long outage against an hourly job), the catch-up is exactly one
fire per job — never a burst. How many were missed is deliberately not
counted.

### Persistence

One column, `last_fired_at TEXT`, on `cron_jobs` (ISO-8601 UTC):

- It stores the **scheduled occurrence instant** the most recent
  accepted fire served — occurrence-to-occurrence comparison is what
  makes restarts idempotent: a boot right after a clean fire sees
  `t == last_fired_at` and does nothing.
- Written at fire start, before any await. A failed run has still served
  its occurrence — the same stance the retire-after-fire rule takes;
  failure retries stay out of scope.
- The write is best-effort: a database failure logs and the fire
  continues. A lost write costs at most one duplicate catch-up after a
  later restart, never a missed run.
- Inserts seed it to now (a job cannot have been missed before it
  existed); edits, renames, and pause/resume never touch it. The
  migration (`ALTER TABLE`, pragma-guarded) seeds existing rows to the
  migration moment so the first upgraded boot does not mass-fire.

### Detection

Croner, the same engine that fires: a name-less, callback-less probe
over the same pattern and timezone asks `nextRun(last_fired_at)`; if
that instant is ≤ now the job missed something, and `previousRuns(1)`
names the latest occurrence to serve. Both sides resolve a schedule —
DST shifts, nonexistent wall clocks — identically. One-shots need no
probe: their occurrence is the parsed schedule instant, and the
retire-after-fire invariant means a still-present row with a past moment
and no marker was necessarily never fired (a marker saying served means
only the retirement delete failed — the next boot finishes it, without
firing again).

### Semantics

| Case | Behavior |
|----|----|
| Occurrence fires while serve runs | unchanged |
| One-shot passes while serve is down | fires once at boot, then retires |
| Recurring occurrence passes while serve is down | latest missed occurrence fires at next boot |
| Long outage, many missed occurrences | exactly one catch-up (the latest) |
| Pause across an occurrence, resume after | one catch-up on resume |
| Disabled job / one-shot past while disabled | never catches up (one-shot removed unfired) |
| Edit / rename / re-save | marker untouched — never re-fires |
| Restart right after a normal fire | no catch-up (`t == last_fired_at`) |

The reload signature deliberately ignores `last_fired_at`: every fire
updates it, and a marker-only change must not reschedule anything.

## Consequences

- A `serve` restart no longer silently drops runs — the user’s ask: *if
  the time passes and the process is not running, the next time the
  process runs, the task should trigger.*
- Resume after a pause now surfaces the latest missed occurrence — a
  deliberate behavior change from “a missed moment stays missed”.
- `cron.db` gains one nullable column (auto-migrated); no changes to
  `cron_sessions`, routes, runner, or UI — from the UI a catch-up fire
  is indistinguishable from a normal one (a “caught up” badge is a
  possible follow-up).
- No staleness window (a one-shot missed by days still fires late; the
  log line names the scheduled instant so a surprised user can see why)
  and no opt-out flag in v1; both are cheap to add later.

## Update — 2026-09-25: the in-place column migration is removed

The pragma-guarded `ALTER TABLE` that added `last_fired_at` to databases
created before catch-up, and the one-time seed that marked existing rows
as served, are gone: every store already carries the column, and new
databases get it from the create-table schema. The marker’s semantics
are unchanged — inserts still seed it to now, and only the scheduler’s
fire path (`recordCronFire`) updates it.
