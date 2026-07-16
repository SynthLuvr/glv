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
  your browser, and can start new `goose run` sessions from the detail
  pane. The sidebar shows a `+` button (and a call-to-action when empty)
  that opens a new-session form — just pick a working directory and type
  a prompt. The session appears in the sidebar the moment goose writes
  it, and its output streams live in the right pane.

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
- `--auth-db <path>` — override the auth database location (default
  `~/.local/share/glv/auth.db`, or `GLV_AUTH_DB`).
- `--limit <n>` — number of rows to list (default 20).

`glv serve` options:

- `-p, --port <number>` — port to listen on (default `3000`).
- `-c, --max-concurrent <number>` — maximum concurrent `goose` runs
  driven from the detail pane (default `6`).
- `--goose-binary <path>` — path to the `goose` binary used to run
  prompts (default `goose` on `PATH`).
- `--rp-name <name>` — WebAuthn relying party name shown in the OS
  passkey prompt (default `Goose Log Viewer`).
- `--rp-id <domain>` — WebAuthn relying party ID; must match the domain
  the browser uses (defaults to the request host, e.g. `localhost`).

## Authentication

The web viewer is protected by **passkey authentication** (WebAuthn) —
no emails, no passwords. The first person to visit a freshly started
viewer creates a passkey and permanently claims the app; every
subsequent registration attempt is blocked. The authorized user can log
back in at any time with a quick passkey tap.

- **Auth database** — passkey credentials and login sessions live in a
  separate SQLite database at `~/.local/share/glv/auth.db`, fully
  independent of the read-only goose sessions database. Override with
  `--auth-db <path>` or the `GLV_AUTH_DB` environment variable.
- **Single-occupancy model** — a `users` table with at most one row
  enforces “first user wins.” Registration endpoints return `403` once
  an owner exists.
- **Sessions** — a 1-day sliding session stored as an `httpOnly`,
  `sameSite=Strict` cookie backed by a `sessions` table row. Revocation
  is a single `DELETE`; re-login is one passkey prompt.
- **Relying Party** — `--rp-name` sets the label shown in the OS passkey
  prompt. `--rp-id` overrides the Relying Party ID.

> **HTTPS requirement.** WebAuthn requires a secure context. `localhost`
> is exempt, so local development needs no TLS. If the viewer is exposed
> on a LAN hostname or over the network, place it behind a reverse proxy
> with a valid TLS certificate.

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
