# Proposal: Chained scheduled runs — stack follow-on prompts on a cron job

- Status: Accepted — implemented (see the PR adding `follow_ups`, the
  chain driver in `runFire`, and the `cron-chain` suites; deviations
  from the sketch are recorded inline below)
- Date: 2026-09-09
- Author: Regan + goose
- Related: `docs/decisions/0003-cron-jobs-in-sqlite.md` (job store), the
  runner’s in-session prompt chain (`src/glv/runner/queue.ts`)

## Problem

A scheduled run today is a single prompt: the job fires, one session is
created, and that is the end of the job’s involvement. There is no way
to say “after this task finishes, run this next task, then this one.”

Users want pipelines — e.g. *run the nightly sweep*, then *summarize the
results into a report*, then *file the report as a PR* — expressed on
one scheduled job, stacked in the UI.

## Goal

When editing an existing scheduled task on the New Session page, a **+
button under the existing prompt** adds another prompt. Each additional
prompt is a **follow-on step**: after the previous step’s session
*finishes*, glv starts a **new session** for the next prompt. Steps
stack arbitrarily (capped) and run strictly in order.

Explicitly in scope: the edit form (`/cron/:name/edit`), persistence,
scheduler chaining, and the management card/confirmation display. Out of
scope for v1: the initial “Schedule…” save form gaining the same plus
button (fast-follow; the data model and PUT route accept follow-ons
either way), and resuming chains across a server restart (see “Restart
behavior”).

## Current behavior (verified)

- Jobs live in `cron_jobs` (`src/glv/cron-jobs.ts`): one row per job
  with `prompt`, `schedule`, `working_dir`, optional timezone/model pin.
  Rows are always written whole (insert/upsert), never patched; `name`
  is the primary key and renames re-key the row.
- A fire (`runFire` in `src/glv/cron.ts`) pulls the repo, starts a run
  via the flavor’s `SessionLauncher`, awaits the real session id,
  establishes, and tags it in `cron_sessions` so the sidebar badges the
  job name. While a fire is in flight, the `establishing` set makes
  later ticks of the same job skip, and the per-directory
  `withCreateLock` serializes against other creates in that directory.
- Completion is only observable by polling: the runner registry flips a
  run’s status to `completed` / `stopped` / `error` when the agent
  process exits (`src/glv/runner/queue.ts`), and `/events/status` polls
  `activeStatuses` at `statusPollMs` (default 1s,
  `src/glv/server/index.tsx`). Terminal handles linger ~30s
  (`terminalRetentionMs`) before eviction; `rekey` mutates the handle in
  place, so a handle object reference stays valid across the temp-key →
  real-id transition.
- The runner already chains *prompts inside one session*
  (`pendingPrompts` / `advanceChain`): a run that errors still advances,
  only `stopped` ends the chain. The feature proposed here is different
  — each step is a **new session** — but the precedent for
  error-continues/stopped-aborts semantics is worth keeping.

## Proposal

### 1. UX — plus button under the prompt (edit form)

`ScheduleJobEditForm` (`src/glv/views/schedule.tsx`) gains, under the
prompt textarea, a **“+ Add follow-on”** button:

- Clicking it appends a stacked step block: a labeled textarea (“Then
  run — starts a new session after the one above finishes”) with a **×**
  remove button. Pure client-side DOM via a small addition to
  `src/glv/scripts/schedule.ts` (delegated listeners, so htmx swaps —
  rejected-submit re-renders, card restore — need no re-wiring).
- Steps stack: plus again for a third step, and so on (cap below).
- No server round-trip to add/remove a field. The existing Save (PUT
  `/cron/:name`) → card swap flow is unchanged for the user.

Card display (`ScheduleJobCard`): jobs with follow-ons show a steps
chip, e.g. `3 steps →` with each step’s first line truncated, so the
pipeline is visible without opening the editor. `ScheduleConfirmation`
gains a “Steps” row listing them after a save.

### 2. Data model — JSON column on the job row

Add one column to `cron_jobs`:

``` sql
follow_ups TEXT NULL  -- JSON array of prompt strings, step order
```

- Idempotent migration in `openCronDb` (it already creates the schema on
  open): check `PRAGMA table_info(cron_jobs)`,
  `ALTER TABLE … ADD COLUMN` when missing. Existing databases upgrade in
  place at boot.
- Why a JSON column and not a `cron_job_steps` child table: rows are
  always read and written whole, `name` is the primary key so a child
  table would need rename cascades and multi-table transactions, and
  chains are never queried partially. One column keeps the UPSERT-shaped
  write path untouched (`cron-jobs.ts` comment: “the UI never patches
  single columns”).
- Row validation stays strict, consistent with the existing philosophy
  (“a drifted or tampered row is dropped rather than trusted”): `JobRow`
  gains `follow_ups: string | null`; `mapRow` JSON-parses it against an
  arktype `string[]` schema, trims entries, drops blanks, and enforces
  the cap. A malformed value surfaces as a read error naming the row
  (the config-file tradition of refusing rather than guessing) — the
  scheduler keeps the previous schedule and the UI shows the read error,
  so a hand-edit is fixable instead of silently ignored.
- Nothing else migrates: the store is the only source of job rows (the
  legacy config-file bridge is gone), so a `NULL` column is simply a job
  with no follow-ons.
- Cap: **10 steps total** (first prompt + 9 follow-ons). A plain
  constant (`MAX_CRON_STEPS`); the UI and the PUT route both enforce it.

### 3. Scheduler — the chain driver (`src/glv/cron.ts`)

`ResolvedJob` gains `followUps: readonly string[]`. `runFire` becomes a
chain driver:

1.  Step 1 is today’s flow unchanged: pull → `startNew` → `awaitNew` →
    `establish` → `tagSession(sessionId, job.name)`.
2.  Capture the run’s `InternalHandle` via
    `getHandle(runner, sessionId)` after `establish` (the handle object
    survives `rekey`, so this reference stays readable; the 30s eviction
    window dwarfs the poll interval).
3.  Poll that handle’s `status` every ~1s (constant +
    `GLV_CRON_CHAIN_POLL_MS` env override for tests, mirroring
    `GLV_CRON_SESSION_TIMEOUT_MS`). On a terminal status, run the next
    step: `startNew` with the step’s prompt, same `workingDir` and model
    pin, inside the same per-directory `withCreateLock` and tagged with
    the same job name (every step’s session badges in the sidebar).
4.  **Chain continues on `completed` and `error`; aborts on `stopped`.**
    This mirrors the runner’s in-session rule (`advanceChain`: a run
    that errored still chains onward; only a stop ends it). A user who
    stops a step’s session clearly wants the pipeline to halt; a step
    that errored may still have produced useful state for the next step.
5.  **Mid-chain liveness check:** before each step, re-read the cron DB.
    If the job was deleted or paused since the fire, abort the remaining
    steps (log line). One exception: a one-shot’s own retirement must
    not abort its chain — the scheduler retires one-shots after their
    moment passes, and that is not the user deleting the job.
6.  Repo pulls happen **before step 1 only**. Mid-chain pulls could
    rebase or move the directory out from under a pipeline that just
    produced artifacts; a chain is one logical run over one snapshot.

Behavior changes to be aware of:

- **`establishing` now spans the whole chain**, not just session
  creation. A fire whose predecessor’s chain is still running skips
  (logged). Today an hourly job with a 3-hour session still fires a
  fresh session every hour; with chains, stacking whole duplicate
  pipelines is almost never what the user wants, and skipping matches
  the existing in-flight guard. This is the one deliberate semantic
  change to un-chained jobs (a job with no follow-ups releases
  `establishing` exactly as today).
- There is no overall chain timeout — a chain runs as long as its
  sessions run, same as a plain session today.

### 4. Routes and validation (`src/glv/server/routes/cron.tsx`)

- PUT `/cron/:name` reads repeated `follow_up` fields (`parseBody` with
  `all: true` already yields arrays for repeated fields — see
  `trimmedField`). Server-side: trim, drop blanks, enforce the 10-step
  cap, store the JSON column. Validation failures re-render
  `ScheduleJobEditForm` with the submitted follow-ups restored (the
  component gains an optional `followUps` prop for the reject path, the
  same pattern as `schedule`/`timezone` restore).
- POST `/cron` (the Schedule… save form) is unchanged: it schedules the
  page’s single prompt. Follow-ons are added by editing the job —
  exactly the flow requested.
- The scheduler’s whole-set validation (`validateCronJobSet`) checks
  only shape (array of non-empty strings, cap); schedules/dirs/model
  rules are per-step-invariant and already validated once per job.

### 5. Restart behavior (v1 limitation, stated up front)

Chains are driven by the serving process. If glv restarts mid-chain, the
remaining steps are dropped — sessions step 1 created survive, but steps
2..n never run, and v1 cannot even report this reliably, since
distinguishing “completed” from “killed by restart” needs
flavor-specific transcript readers.

Documented limitation in v1, with a cheap v2 path sketched: persist
`(job_name, next_step_index, last_session_id)` in a `cron_chains` table
at each step boundary; at boot, mark interrupted chains and either skip
or resume them. Deferred because resume semantics (re-run last step?
skip?) deserve their own decision.

## Tests (per AGENTS.md: integration over localhost HTTP, no function mocks)

New shared suite `src/glv/tests/suites/cron-chain.suite.ts`, bound by
thin wrappers in `src/goose/tests/` and `src/claude/tests/`
(`cron-chain.integration.test.ts`), using the existing harness: real
`serve` process, mock agent script, `authedFetch`, `withPage`,
`readCronJobRows`.

1.  **Persistence via UI:** PUT with two follow-ups → rows in `cron.db`
    carry the JSON array; re-GET the edit form shows all three textareas
    pre-filled.
2.  **Chain end-to-end:** one-shot job with two follow-ups, mock agent
    that exits promptly → poll `/sessions` until step-2 and step-3
    sessions appear, each tagged with the job name, prompts matching the
    steps (asserted over HTTP against the session list/transcript, never
    by importing server internals).
3.  **Stop aborts:** stop step 1’s session mid-run → no step-2 session
    ever appears (bounded poll).
4.  **Pause aborts:** pause the job between steps → remaining steps
    never run.
5.  **Error continues:** mock script exits non-zero on step 1 → step 2
    still starts.
6.  **Cap:** 10 follow-ups submitted → rejected with the cap copy (the
    PUT route rejects inside a 200 swap, like every other edit-form
    rejection — htmx only swaps 2xx, so the re-render with the restored
    steps must be a 200); 9 → saved.
7.  **Rename keeps steps:** PUT rename → row re-keyed with follow-ups
    intact.
8.  **UI interactions (`withPage`):** plus adds a textarea, × removes
    it, card shows the steps chip, blank follow-ups are silently
    dropped.
9.  **Overlap skip:** an every-minute job with a slow mock first step
    logs the skip rather than stacking a second pipeline.

Coverage floors in `vitest.config.ts` hold because every touched path is
exercised by these suites.

## Files touched

| File | Change |
|----|----|
| `src/glv/cron-jobs.ts` | Schema + migration, `JobRow`/`mapRow` |
| `src/glv/schedule.ts` | `MAX_CRON_STEPS` — lives here, not the store, so the client bundle (`scripts/schedule.ts` enforces the same cap) can import it without reaching `node:sqlite` |
| `src/glv/cron.ts` | `ResolvedJob.followUps`, chain driver in `runFire`, liveness check, one-shot retire timing |
| `src/glv/server/routes/cron.tsx` | PUT parses/validates `follow_up`, reject-path restore |
| `src/glv/views/schedule.tsx` | Plus button, step blocks in `ScheduleJobEditForm`, card chip, confirmation Steps row |
| `src/glv/scripts/schedule.ts` | Delegated add/remove-step handlers |
| `src/glv/styles/app.css` | Step block + chip styles |
| `src/glv/tests/suites/cron-chain.suite.ts` | New shared suite |
| `src/glv/tests/harness.ts` | `follow_ups` in `readCronJobRows`/`seedCronJobRow` |
| `src/goose/tests/`, `src/claude/tests/` | Thin wrappers |

No runner changes — completion observation uses the registry as-is.

## Open questions

1.  **Error continuation** — proposed: continue (mirrors the runner’s
    in-session rule). Alternative: abort the chain when a step errors.
2.  **Overlap** — proposed: skip fires while a chain runs. Alternative:
    let pipelines overlap like plain fires do today.
3.  Should the **Schedule… save form** get the same plus button in v1
    (slightly awkward: its first prompt lives in the New Session form
    above, follow-ons would live in the schedule form) or stay
    edit-only?
4.  Sidebar nicety: record a step index in `cron_sessions` so badges
    could read “Nightly sweep · step 2/3” — deferred; the tag schema
    change is easy to add later.
