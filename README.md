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

`glv serve` options:

- `-p, --port <number>` — port to listen on (default `3000`).
- `-c, --max-concurrent <number>` — maximum concurrent `goose` runs
  driven from the detail pane (default `6`).
- `--goose-binary <path>` — path to the `goose` binary used to run
  prompts (default `goose` on `PATH`).

## Development

``` bash
pnpm install
pnpm build    # type-check + compile the Tailwind stylesheet
pnpm test     # run tests
pnpm lint     # lint all files
```

The web viewer is styled with [Tailwind CSS
v4](https://tailwindcss.com). The stylesheet source
(`src/styles/app.css`) uses Tailwind’s CSS-first setup —
`@import "tailwindcss"` plus a `@theme` block of design tokens — and is
compiled to `dist/app.css` by `pnpm build:assets` (see `src/build.ts`).
`glv serve` rebuilds it automatically before listening, so the viewer
always serves current styles. Browser client scripts are written as
TypeScript in `src/scripts/` and compiled to minified `dist/*.js` by the
same command, which `glv serve` also rebuilds before listening.
