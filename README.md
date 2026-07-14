# goose-log-viewer

A small CLI to inspect your [goose](https://github.com/block/goose)
session history stored on disk.

## What it does

- **`glv sessions`** — list your goose sessions (interactive `user`
  sessions).
- **`glv view <id>`** — show the prompts and final outputs for a
  session.
- **`glv logs`** — list sessions from `goose run --no-session` runs
  (stored as `hidden` sessions).
- **`glv serve`** — start a local web viewer that browses sessions in
  your browser.

Sessions are read from the goose SQLite database at
`~/.local/share/goose/sessions/sessions.db` (opened read-only, so it is
safe to use while goose is running).

## Setup

``` bash
./setup.sh
```

This installs dependencies and symlinks the `glv` launcher onto your
PATH (`~/.local/bin/glv`). Re-running is safe.

## Usage

``` bash
glv sessions              # list recent sessions
glv view 20260713_120     # show prompts + outputs for a session
glv logs                  # list --no-session runs
glv serve                 # start the local web viewer
```

Global options:

- `--db <path>` — override the database location.
- `--limit <n>` — number of rows to list (default 20).

## Development

``` bash
pnpm install
pnpm build    # type-check
pnpm test     # run tests
pnpm lint     # lint all files
```
