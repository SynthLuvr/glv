# goose-log-viewer

A small CLI to inspect your [goose](https://github.com/block/goose) session
history stored on disk.

## What it does

- **`glv sessions`** — list your goose sessions (interactive `user` sessions).
- **`glv view <id>`** — show the prompts and final outputs for a session.
- **`glv logs`** — list sessions from `goose run --no-session` runs (stored as
  `hidden` sessions).

Sessions are read from the goose SQLite database at
`~/.local/share/goose/sessions/sessions.db` (opened read-only, so it is safe to
use while goose is running).

## Usage

```bash
pnpm glv sessions              # list recent sessions
pnpm glv view 20260713_120     # show prompts + outputs for a session
pnpm glv logs                  # list --no-session runs
```

Global options:

- `--db <path>` — override the database location.
- `--limit <n>` — number of rows to list (default 20).

## Development

```bash
pnpm install
pnpm build    # type-check
pnpm test     # run tests
pnpm lint     # lint all files
```
