# ADR 0003: Store cron jobs in SQLite

- Status: Accepted
- Date: 2026-09-08
- Deciders: glv maintainers

## Context

Scheduled runs (“cron jobs”) are the only piece of glv state still kept
in the hand-editable config file (`~/.config/<flavor>/config.json`,
`GLV_CONFIG`). Every other mutable surface already lives in a glv-owned
SQLite database — saved prompts (`prompts.db`), session groups
(`groups.db`), auth (`auth.db`), and the cron session-tag sidecar
(`cron.db`) — opened with a busy timeout and created on first use.

Keeping jobs in the config file costs real complexity:

- `config.ts` carries a read-modify-write layer just for the `cronJobs`
  array (append/delete/whole-file rewrites that must preserve every
  other key), plus a config-file watcher (`fs.watch` + content-comparing
  poll + debounce) whose only remaining job is cron live-reload —
  `forwardHost`, the other config key, is read once at boot.
- Because the file is hand-editable, serve must defend against every
  hand-edit shape: invalid JSON, non-array `cronJobs`, half a model pin,
  duplicate names, unnamed entries (resolved to `cron-<n>` by position),
  expired one-shots left behind.
- The UI mutates jobs by rewriting a JSON file the user may also have
  open in an editor, and the scheduler learns about changes by
  re-reading and diffing that file.

## Proposal

Move the job store into SQLite and shrink the config file to what it is
for every other setting: boot-time scalar configuration.

### Storage

A `cron_jobs` table in the existing cron database — the same glv-owned
`cron.db` that already holds the `cron_sessions` tag sidecar, resolved
the same way (`--cron-db` flag → `GLV_CRON_DB` env → platform default
under the flavor’s data dir):

``` sql
CREATE TABLE IF NOT EXISTS cron_jobs (
  name           TEXT PRIMARY KEY,
  schedule       TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  working_dir    TEXT NOT NULL,
  timezone       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  model_provider TEXT,
  model          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `name` is the primary key: the UI, the routes (`/cron/:name`), and the
  scheduler already treat names as the stable identity, and the UI has
  always required unique names. Every row is named — the positional
  `cron-<n>` fallback for unnamed entries is applied once, at migration.
- One file for both cron tables (jobs + session tags) rather than a
  fifth database file: same lifecycle, same owner, and the sidecar is
  tiny. `openCronDb` creates both schemas on open, like every other
  glv-owned open does for its own.
- One handle per serve process shared by the scheduler, the routes, and
  the badge reads; `openGlvDb`’s `busy_timeout=5000` covers external
  writers.

### Live reload

The config-file watcher is replaced by a database poll plus an
in-process nudge:

- mutations made by the web UI call the scheduler’s reload directly, so
  they apply instantly, as before;
- a poll (default 5s, `GLV_CRON_DB_POLL_MS` override, replacing
  `GLV_CONFIG_WATCH_POLL_MS`) re-reads the table so edits from other
  processes (a future `cron` CLI, direct sqlite3 use) still land, and
  the reload no-ops when the resolved job set is unchanged — same
  contract the file watcher had.

Semantics are otherwise unchanged: a reload only swaps the schedule once
the whole new set validates; an invalid set is logged and the running
schedule kept; in-flight runs finish.

### Migration of existing jobs

At serve boot, before the scheduler starts:

1.  If the config file has no `cronJobs` key, nothing happens (the
    common case after the first run).
2.  The value is structurally validated with the same schema the config
    used to enforce (an invalid file fails serve with the same messages
    as today).
3.  The entries are merged into the table — config entries win on a name
    collision, so a user who re-adds jobs to the file after migrating
    gets them once, not duplicated.
4.  The merged set is validated with the scheduler’s own validation
    (unique names, parseable schedules, known timezones, whole model
    pins, existing working directories). On failure serve refuses to
    start and **the config file is left untouched** — the old hand-edit
    recovery story survives the migration itself.
5.  On success the rows are inserted in one transaction and the config
    file is rewritten without `cronJobs` (all other keys preserved),
    with a line logged naming the count and destination.

After migration the config file keeps only `forwardHost` (and any future
non-job keys); `CONFIG_KEYS` drops `cronJobs`, so
`glv config set cronJobs …` now reports it as unknown.

### What does not change

- Job semantics: schedules (cron / one-shot / English→cron), timezone
  overrides, pause/resume, one-shot retirement, per-fire session
  establishment, model pins, boot-time fail-fast naming the offending
  job.
- The web UI and every route path; the section copy still promises live
  application of changes.
- `GLV_CONFIG` and the config file itself — only its `cronJobs` key is
  retired.

## Consequences

- Hand-editing jobs means editing SQLite (or the web UI) instead of
  JSON. This is the intended trade: the file was the only hand-edit
  surface, and every hand-edit shape needed dedicated defense. The
  migration preserves the fail-fast-and-fix-by-file path one last time
  for files that are already invalid.
- The scheduler learns about external edits within one poll interval
  instead of one file-watch debounce; UI edits remain instant via the
  in-process nudge.
- `cron.db` becomes required state for serve (it already was — the badge
  sidecar lived there), now holding the schedule itself; it is a normal
  SQLite file, safe to back up or copy wholesale.

## Update — 2026-09-08: the migration bridge is removed

The boot-time import (`migrateCronJobsFromConfig`) did its job and is
gone. On the reference install the migration ran at the first `serve`
boot after this ADR landed: the three real jobs moved into `cron.db`,
the `cronJobs` key was stripped, and the schedule came up from the
database (`cron: migrated 3 job(s) …` in the journal) — verified before
the code was deleted. Installs that never had a `cronJobs` key were
always in the no-op steady state.

What remains of the old store is the config file itself, reduced to
boot-time scalars (`forwardHost`). A stray `cronJobs` key is now inert:
no code reads it, and `config set cronJobs` reports it as unknown. Every
job is named (name is the primary key), so the positional `cron-<n>`
fallback and the optional-name job shape went with the migration; the
scheduler’s fail-fast boot validation over the database rows is
unchanged.

Two hand-edit defenses became structure instead of validation. Duplicate
names were impossible to store all along — name is the table's primary
key — and the row mapping reads `model_provider`/`model` as a pair, so a
half pin cannot exist either; the boot checks for both are gone. The
rejections users still see are the save-time ones: the form refuses a
name that already exists, and claude refuses any pin at boot.
