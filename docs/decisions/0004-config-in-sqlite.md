# ADR 0004: Store config in SQLite, retire the config file

- Status: Accepted
- Date: 2026-09-08
- Deciders: glv maintainers

## Context

After ADR 0003 moved scheduled runs out of it, the hand-editable config
file (`~/.config/<flavor>/config.json`, `GLV_CONFIG`) held a single
scalar key — `forwardHost` — read once at boot. It was the last
file-based store in a codebase where every other glv-owned surface is a
SQLite database opened with a busy timeout and created on first use
(`auth.db`, `prompts.db`, `groups.db`, `cron.db`, `meta.db`).

Keeping a one-key JSON file costs more than it returns:

- a second persistence layer (JSON parse/validate/rewrite, unknown-key
  preservation, `GLV_CONFIG` path resolution) maintained for one string;
- a per-machine setting that lives outside the flavor’s data directory,
  so a machine’s glv state is split across two locations
  (`~/.config/<flavor>` and `~/.local/share/<flavor>`);
- hand-edit shapes to defend against forever (invalid JSON, non-object
  roots) for a value the `config set` CLI already writes safely.

## Proposal

Retire the file entirely and store config in a glv-owned SQLite
database, like every other store.

### Storage

A `config` key/value table in a new `config.db`, resolved the same way
as its siblings (`--config-db` flag → `GLV_CONFIG_DB` env → platform
default under the flavor’s data dir):

``` sql
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `CONFIG_KEYS` (currently just `forwardHost`) still gates
  `config get/set`; unknown keys already in the table are listed but
  never settable, exactly as unknown file keys behaved.
- Values are TEXT. The CLI passes strings; a migrated non-string file
  value is stored the way `config list` always displayed it
  (`JSON.stringify`).
- serve opens the database alongside the others (created on first use,
  closed on shutdown); the `config` CLI commands open it per invocation.

### Boot flow

`serve --forward` now resolves its host **inside** serve, after the
legacy import below — so a first boot whose `forwardHost` still lives in
a file finds it, and every later boot reads only the database. The
missing-key error names the fixing command
(`glv-<flavor> config set forwardHost <host>`).

### Migration of the legacy file

At serve boot, before the scheduler starts, when a config file still
exists (default path or `GLV_CONFIG`):

1.  It is parsed with the reader’s old validation — invalid JSON or a
    non-object root refuses startup, leaving the file hand-fixable.
2.  Its `cronJobs` array (the ADR 0003 bridge) is imported into the cron
    database with the existing semantics: file entries win on a name
    collision; the whole merged set is validated first, and a refusal
    leaves the file untouched.
3.  Every remaining key is imported into `config.db`. The database wins
    on collision (`ON CONFLICT DO NOTHING`), so values the user already
    set through the new store are never overwritten by stale file
    contents.
4.  The file is renamed to `config.json.bak` — retired, but with a copy
    left behind rather than destroyed.

Steps 2–3 happen only when a file exists; after the first boot the
bridge never runs again.

## Consequences

- All per-flavor state now lives under one data directory; backing up or
  copying it captures everything glv owns.
- Editing config means the `config` CLI (or sqlite3), not a text editor.
  That is the intended trade: the file was down to one key that the CLI
  already managed.
- `GLV_CONFIG` is honored only by the migration bridge; after the first
  boot it is ignored. `GLV_CONFIG_DB` overrides the database.
- `config.json.bak` files accumulate nothing and are never read again;
  users may delete them.
