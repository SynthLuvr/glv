# Guided Live Velocity

A self-hosted web app that **increases your development speed with
agentic coding**. Guided Live Velocity drives the [claude
Code](https://claude.com/product/claude-code) engine from a fast browser
UI: launch guided coding sessions, watch them stream live, and turn raw
transcripts into navigable, searchable velocity.

claude Code records every session — prompts, model responses, tool
calls, and reasoning — as JSONL transcript files under `~/.claude`.
**Guided Live Velocity** (or **glv**) turns those transcripts into a
fast, self-hosted web UI: browse past sessions, watch live runs stream
in real time, kick off fresh runs, and even launch claude against a
GitHub repository — all without leaving the browser.

## Why

- **Ship faster with agentic coding.** Guided Live Velocity puts the
  claude Code engine behind one fast UI, so you spend less time juggling
  terminals and more time shipping guided, live-streamed sessions.
- **Make your session history navigable.** claude’s transcripts are rich
  (markdown, tool calls, thinking blocks, token usage), but they live in
  JSONL files that are hard to read directly. glv renders them as a
  clean, searchable web transcript.
- **Run claude from a UI.** Instead of juggling terminals, start a new
  `claude --print` run from a form, queue follow-up prompts, and watch
  the output stream live — on one machine or many.
- **Safe to use alongside claude.** Browsing is read-only, and the only
  writes are viewer-side archive/rename metadata in glv’s own sidecar
  database — never to the transcript files a running claude session is
  appending to.
- **Private by design.** The viewer is protected by passkey
  authentication and runs entirely on your own machine.

## Features

- **Session browser.** A sidebar lists every claude session with its
  name, working directory, token count, and last-updated time. Select
  one to read the full transcript of prompts and outputs.
- **Live streaming.** Start a run in the viewer and its output streams
  in real time via Server-Sent Events. The session appears in the
  sidebar the moment claude writes it.
- **New sessions.** A `+` button opens a form to start a fresh claude
  run. Pick a **working directory** on disk, or point claude at a
  **GitHub repository** — glv clones the repo (using your existing `gh`
  auth) and runs claude against it.
- **Queued follow-ups.** While a session is running you can queue
  follow-up prompts that chain together once the current run finishes.
  Runs are governed by a concurrency-limited queue (six by default).
- **Tail external sessions.** Sessions started from the terminal,
  desktop, or another CLI are tracked too — glv polls the shared
  projects directory and streams only the deltas, so you can keep an eye
  on a run from anywhere.
- **PR tracking.** When a session mentions a GitHub pull request, glv
  surfaces a link with a live open / merged / closed status badge (via
  `gh`).
- **Session management.** Rename sessions, and archive them one at a
  time or in bulk.
- **Dark and light themes.**
- **Passkey login.** The whole app is gated behind WebAuthn passkey
  authentication — no emails, no passwords.

## How it works

glv is a single Node.js process built on the [Hono](https://hono.dev)
web framework:

- **Reads claude’s transcripts directly.** Sessions are read from the
  JSONL files claude writes under `~/.claude/projects` — one file per
  session, grouped by working directory. Browsing only ever reads those
  files; the sole writes are viewer-managed archive and rename metadata,
  kept in a separate glv-owned database, so it is always safe while
  claude is running.
- **Server-rendered with interactivity.** Pages are rendered server-side
  with `hono/jsx` and updated incrementally with
  [htmx](https://htmx.org) — there is no client-side SPA to build or
  ship. Styling is [Tailwind CSS v4](https://tailwindcss.com).
- **A runner spawns claude.** When you start or resume a session, glv
  spawns a `claude --print --output-format stream-json` subprocess,
  feeds the prompt over stdin, and parses the NDJSON output. A `p-queue`
  caps how many claude processes run at once; surplus prompts are queued
  and chained automatically.
- **Live updates over SSE.** Active runs stream through
  `/sessions/:id/stream`; sessions started elsewhere are followed via
  `/sessions/:id/tail`, which polls the shared transcripts for new and
  edited messages.
- **Sanitized output.** All model and tool output is rendered as
  GitHub-Flavored Markdown and sanitized with DOMPurify before it
  reaches the browser.

## Setup

``` bash
node scripts/setup.mjs
```

This installs dependencies and installs the `glv` launcher onto your
PATH (`~/.local/bin/glv` on macOS/Linux,
`%USERPROFILE%\.local\bin\glv.cmd` on Windows). `./setup.sh` remains as
a thin Unix wrapper. Re-running is safe.

### Prerequisites

- **Node.js ≥ 24** and **pnpm ≥ 10**.
- The **`claude`** binary (claude Code ≥ 2.x) on your `PATH`,
  authenticated, to start new runs from the viewer.
- The **`gh`** CLI, authenticated, to use the GitHub repository source
  and PR status features.
- **pandoc ≥ 3.1** (only needed for the Markdown lint/format check
  during development).
- An **`ssh`** client (OpenSSH) on your `PATH` — only needed for the
  `--forward` reverse-tunnel flag. It ships with Linux and macOS; on
  Windows 10/11 install the optional **OpenSSH Client** feature.

## Running the web viewer

``` bash
glv serve
```

Open the printed URL (e.g. <http://localhost:3000>). The first visitor
is prompted to create a passkey and permanently claims the app.

Options:

- `-p, --port <number>` — port to listen on (default `3000`).

- `-c, --max-concurrent <number>` — maximum concurrent `claude` runs
  driven from the viewer (default `6`).

- `--claude-binary <path>` — path to the `claude` binary used to run
  prompts (default `claude` on `PATH`).

- `--projects-dir <path>` — override the claude transcripts directory
  (default `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` when
  `CLAUDE_CONFIG_DIR` is set — the same env var the claude CLI itself
  honours).

- `--meta-db <path>` — override the viewer metadata database location
  (default `~/.local/share/glv/meta.db` on Linux/macOS
  (`%APPDATA%\glv\meta.db` on Windows), or `GLV_META_DB`).

- `--auth-db <path>` — override the auth database location (default
  `~/.local/share/glv/auth.db` on Linux/macOS (`%APPDATA%\glv\auth.db`
  on Windows), or `GLV_AUTH_DB`).

- `--rp-name <name>` — WebAuthn relying party name shown in the OS
  passkey prompt (default `GLV`).

- `--rp-id <domain>` — WebAuthn relying party ID; must match the domain
  the browser uses (defaults to the request host, e.g. `localhost`).

- `--forward` — open an SSH reverse tunnel so the viewer is reachable on
  a remote host. When set, `glv` runs
  `ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 127.0.0.1:<port>:127.0.0.1:<port> <host>`,
  binding the serve port on the remote host back to the local viewer.
  The tunnel host comes from your [local config
  file](#local-config-file) and is **not** started unless this flag is
  passed.

The viewer rebuilds its stylesheet and client scripts on every start, so
it always serves current assets.

### Local config file

Per-machine settings live outside the repo at
`~/.config/glv/config.json` on Linux/macOS
(`%LOCALAPPDATA%\glv\config.json` on Windows; override with the
`GLV_CONFIG` environment variable), so secrets like a forward host never
get committed:

``` json
{ "forwardHost": "91.98.17.2" }
```

`glv serve --forward` uses `forwardHost` as the SSH tunnel target; the
flag errors out if the key is missing or the file is malformed.

## Authentication

The web viewer is protected by **passkey authentication** (WebAuthn) —
no emails, no passwords. The first person to visit a freshly started
viewer creates a passkey and permanently claims the app; every
subsequent registration attempt is blocked. The authorized user can log
back in at any time with a quick passkey tap.

- **Auth database** — passkey credentials and login sessions live in a
  separate SQLite database at `~/.local/share/glv/auth.db` on
  Linux/macOS (`%APPDATA%\glv\auth.db` on Windows), fully independent of
  claude’s transcript files and the viewer metadata sidecar. Override
  with `--auth-db <path>` or the `GLV_AUTH_DB` environment variable.
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

### Registering a new domain

A passkey is cryptographically bound to the domain (Relying Party ID) it
was created on, so one made on `localhost` cannot unlock a different
domain, and vice versa. To sign in from more than one origin — for
example your local machine *and* a deployed host — register a separate
passkey for each via the single-use **enrollment** flow:

1.  Log in on an origin you already have a passkey for (e.g.
    `http://localhost:3000`).
2.  Visit `/auth/devices` and click **Add a passkey for another device
    or domain**. The viewer mints a one-time enrollment link.
3.  Open that link on the new domain — for another host, swap the
    `localhost` part for your domain (e.g.
    `https://your-host.example/auth/enroll/<token>`). Complete the
    passkey ceremony there; the credential is bound to that origin’s RP
    ID and attached to your existing owner account.
4.  Sign in from either origin. The two passkeys coexist — there’s no
    need to delete the old one.

A cancelled or failed ceremony does not consume the link, so you can
retry with the same URL until one succeeds.

> **Behind a reverse proxy.** When the viewer sits behind a
> TLS-terminating proxy, forward the original request details so
> WebAuthn computes the correct RP origin and cookie flags:
>
> ``` nginx
> proxy_set_header Host $host;
> proxy_set_header X-Forwarded-Host $host;
> proxy_set_header X-Forwarded-Proto $scheme;
> ```

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
Browser client scripts are written as TypeScript in `src/scripts/` and
compiled to minified `dist/*.js` by the same command.

## The CLI

Everything above is driven by the `glv` command, which also offers a few
lightweight terminal commands for quick lookups without opening a
browser:

``` bash
glv sessions              # list recent sessions
glv view <id>             # show prompts + outputs for a session
```
