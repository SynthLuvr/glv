# Guided Live Velocity

A self-hosted web app that **increases your development speed with
agentic coding**. Guided Live Velocity (**glv**) drives a coding agent
from a fast browser UI: launch guided coding sessions, watch them stream
live, and turn raw transcripts into navigable, searchable velocity.

Your agent already records every session — prompts, model responses,
tool calls, and reasoning — on your own disk. glv turns that data into a
fast, self-hosted web UI: browse past sessions, watch live runs stream
in real time, kick off fresh runs, and even launch an agent against a
GitHub repository — all without leaving the browser.

## One core, two agents

glv is one product shipped as two launchers, each driving a different
agentic engine from a shared core (`src/glv/`):

- **`glv-goose`** drives the [goose](https://github.com/block/goose)
  engine and reads its sessions from goose’s on-disk SQLite database.
- **`glv-claude`** drives the `claude` CLI and reads its sessions from
  the JSONL transcripts claude writes under its `projects` directory.

Both flavors serve the same UI and the same features. Wherever the
engines differ — data locations, command-line flags, model pinning —
this README says which flavor a detail applies to.

## Why

- **Ship faster with agentic coding.** glv puts a coding agent behind
  one fast UI, so you spend less time juggling terminals and more time
  shipping guided, live-streamed sessions.
- **Make your session history navigable.** Agent transcripts are rich
  (markdown, tool calls, thinking blocks, token usage), but they live in
  on-disk formats that are hard to read directly. glv renders them as a
  clean, searchable web transcript.
- **Run your agent from a UI.** Instead of juggling terminals, start a
  new run from a form, queue follow-up prompts, and watch the output
  stream live — on one machine or many.
- **Safe to use alongside a running agent.** Browsing is read-only, and
  the only writes are viewer-side archive/rename metadata — never to the
  live session data a running agent is using.
- **Private by design.** The viewer is protected by passkey
  authentication and runs entirely on your own machine.

## Features

- **Session browser.** A sidebar lists every session with its name,
  working directory, provider or model, token count, and last-updated
  time. Select one to read the full transcript of prompts and outputs.
- **Live streaming.** Start a run in the viewer and its output streams
  in real time via Server-Sent Events. The session appears in the
  sidebar the moment the agent writes it.
- **New sessions.** A `+` button opens a form to start a fresh run. Pick
  a **working directory** on disk, or point the agent at a **GitHub
  repository** — glv clones the repo (using your existing `gh` auth) and
  runs the agent against it.
- **Queued follow-ups.** While a session is running you can queue
  follow-up prompts that chain together once the current run finishes.
  Runs are governed by a concurrency-limited queue (six by default).
- **Tail external sessions.** Sessions started from the terminal,
  desktop, or another CLI are tracked too — glv watches the agent’s
  session data and streams only the deltas, so you can keep an eye on a
  run from anywhere.
- **PR tracking.** When a session mentions a GitHub pull request, glv
  surfaces a link with a live open / merged / closed status badge (via
  `gh`).
- **Scheduled runs.** Click “Schedule…” in the Scheduled runs section
  and type a schedule in plain English (“every weekday at 9:00”) or cron
  — validated live before you can click “Schedule run”, converted to the
  equivalent cron pattern on save, with upcoming runs previewed. The
  form sets its own working directory (pre-filled from the New Session
  form and freely editable), so a run can target any directory. Pause,
  edit, and delete from the same section; jobs live in the cron database
  (`cron.db`). Sessions a job starts carry a clock badge naming the job.
  Each job can pin the model its runs use (goose flavor).
- **Session management.** Rename sessions, and archive them one at a
  time or in bulk.
- **Dark and light themes.**
- **Passkey login.** The whole app is gated behind WebAuthn passkey
  authentication — no emails, no passwords.

## How it works

glv is a single Node.js process built on the [Hono](https://hono.dev)
web framework:

- **Reads the agent’s session data directly.** The goose flavor opens
  goose’s SQLite database at
  `~/.local/share/goose/sessions/sessions.db`; browsing opens it
  **read-only** — the only writes are viewer-managed archive and rename
  metadata, routed through a separate writable connection, and they
  never touch the rows a running goose session reads, so it is always
  safe while goose is running. The claude flavor reads claude’s
  append-only JSONL transcripts under its projects root (by default
  `~/.claude/projects`) and never writes to claude’s files at all — the
  same guarantee, so it is always safe while claude is running.
- **Server-rendered with interactivity.** Pages are rendered server-side
  with `hono/jsx` and updated incrementally with
  [htmx](https://htmx.org) — there is no client-side SPA to build or
  ship. Styling is [Tailwind CSS v4](https://tailwindcss.com).
- **A runner spawns the agent.** When you start or resume a session, glv
  spawns the agent’s run command as a subprocess, feeds the prompt over
  stdin, and parses its stream output. A `p-queue` caps how many agent
  processes run at once; surplus prompts are queued and chained
  automatically.
- **Live updates over SSE.** Active runs stream through
  `/sessions/:id/stream`; sessions started elsewhere are followed via
  `/sessions/:id/tail`, which polls the agent’s session data for new and
  edited messages.
- **Sanitized output.** All model and tool output is rendered as
  GitHub-Flavored Markdown and sanitized with DOMPurify before it
  reaches the browser.

## Setup

``` bash
node scripts/setup.mjs
```

This installs dependencies and installs the `glv-goose` launcher onto
your PATH (`~/.local/bin/glv-goose` on macOS/Linux,
`%USERPROFILE%\.local\bin\glv-goose.cmd` on Windows). `./setup.sh`
remains as a thin Unix wrapper. Re-running is safe.

The claude flavor ships from the same checkout and needs no separate
setup — run it with Node directly:

``` bash
node bin/glv-claude.mjs serve
```

(or add your own alias or shim if you want `glv-claude` on your PATH).

### Windows

`node scripts\setup.mjs` does the same on Windows: it installs
dependencies and writes a `%USERPROFILE%\.local\bin\glv-goose.cmd` shim.
If setup warns that the folder is not on your `PATH`, add it (Settings →
System → About → Advanced system settings → Environment Variables) and
open a new terminal; `glv-goose serve` then works from anywhere.

You can also skip the shim and invoke a launcher with Node directly —
this is exactly what the shim runs (`bin\glv-claude.mjs` works the same
way for the claude flavor):

``` powershell
node bin\glv-goose.mjs serve -p 3001
```

Windows notes:

- The launchers hand their TypeScript loader to `node --import` as a
  `file://` URL. A plain `C:\...` path there is rejected by Node’s ESM
  loader (`ERR_UNSUPPORTED_ESM_URL_SCHEME`), so keep a launcher as the
  entry point rather than re-creating the `node --import` chain by hand.
- The goose flavor reads goose’s sessions database from goose’s own
  platform-default location:
  `%APPDATA%\Block\goose\data\sessions\sessions.db` on Windows and
  `~/.local/share/goose/sessions/sessions.db` on Linux/macOS. Point it
  at a different file with `--db <path>` or the `GOOSE_SESSIONS_DB`
  environment variable. The claude flavor reads claude’s transcript
  directory instead — `CLAUDE_CONFIG_DIR\projects` on Windows
  (`~/.claude/projects` by default on Linux/macOS), overridable with
  `--projects-dir <path>`.
- glv-owned data (the auth database, prompt library, and uploads) lives
  under `%APPDATA%\glv-goose` for the goose flavor and
  `%APPDATA%\glv-claude` for the claude flavor. All of it is overridable
  — see the flags below.

### Prerequisites

- **Node.js ≥ 24** and **pnpm ≥ 10**.
- The binary of any agent you want to drive from the viewer — the
  **`goose`** and/or **`claude`** CLI — on your `PATH` (needed to start
  new runs; browsing past sessions works without it).
- The **`gh`** CLI, authenticated, to use the GitHub repository source
  and PR status features.
- **pandoc ≥ 3.10** (only needed for the Markdown lint/format check
  during development).

The toolchain runs on Linux, macOS, and Windows; line endings are
normalized to LF via `.gitattributes`, and pandoc is invoked with
`--eol=lf` so its output stays LF on Windows too.

## Running the web viewer

``` bash
glv-goose serve    # goose flavor
glv-claude serve   # claude flavor
```

Open the printed URL (e.g. <http://localhost:3000>). The first visitor
is prompted to create a passkey and permanently claims the app.

Options:

- `-p, --port <number>` — port to listen on (default `3000`).

- `-c, --max-concurrent <number>` — maximum concurrent agent runs driven
  from the viewer (default `6`).

- `--goose-binary <path>` (goose) / `--claude-binary <path>` (claude) —
  path to the agent binary used to run prompts (default: the agent’s
  name on `PATH`).

- `--permission-mode <mode>` (claude) — claude permission mode for
  glv-launched runs; `inherit` defers to your claude `settings.json`.

- `--db <path>` (goose) — override the goose sessions database location
  (or `GOOSE_SESSIONS_DB`).

- `--projects-dir <path>` (claude) — override the claude projects
  (transcripts) directory; defaults from `CLAUDE_CONFIG_DIR`, else
  `~/.claude/projects`.

- `--auth-db <path>` — override the auth database location (default
  `~/.local/share/glv-goose/auth.db` on Linux/macOS
  (`%APPDATA%\glv-goose\auth.db` on Windows) for the goose flavor, the
  same path under `glv-claude` for the claude flavor; or `GLV_AUTH_DB`).

- `--cron-db <path>` — override the scheduled runs database location
  (same per-flavor defaults as the auth database; or `GLV_CRON_DB`).

- `--rp-name <name>` — WebAuthn relying party name shown in the OS
  passkey prompt (default `GLV`).

- `--rp-id <domain>` — WebAuthn relying party ID; must match the domain
  the browser uses (defaults to the request host, e.g. `localhost`).

The viewer rebuilds its stylesheet and client scripts on every start, so
it always serves current assets.

### Scheduled runs (cron)

Scheduled runs are managed from the **web viewer** (the “Scheduled runs”
section below the New Session form has a “Schedule…” button that opens
an inline form — **type a schedule in plain English or cron**, validated
live as you type with upcoming runs previewed; the run uses the
**working directory (and model, where the agent supports one) from the
New Session form above**; an **optional timezone field** picks the IANA
zone the schedule’s times apply in — searched as you type by zone name,
city (“new york”), or UTC offset (“utc+2”), with each suggestion showing
its current offset; the field stays free-typing (any IANA name is
accepted), and left empty it means the server’s local time; the section
lists every job with pause, edit, and delete). The jobs live in the
**cron database** — a glv-owned SQLite file at
`~/.local/share/glv-goose/cron.db` on Linux/macOS
(`%APPDATA%\glv-goose\cron.db` on Windows; the claude flavor uses the
same path under `glv-claude`), alongside the job-started-session tags
that badge fired runs. Override with `--cron-db <path>` or the
`GLV_CRON_DB` environment variable. The running server picks changes up
live, no restart needed.

Jobs written by hand (or by an older glv) as a `cronJobs` array in the
retired config file were migrated into the cron database by the first
`serve` starts after that file’s retirement — entries won on a name
collision, so nothing was duplicated. Current glv never reads the file,
and a stray `cronJobs` key is inert.

- `schedule` is one of two spellings:

  - a [croner](https://github.com/hexagon/croner) pattern — the usual
    5-field cron (`"0 9 * * 1-5"`), 6 fields with a leading seconds
    part, or a nickname like `"@daily"`.
  - an ISO 8601 local datetime like `"2026-09-03T09:00"` for a one-time
    run. A one-shot fires once and retires itself from the database.
    Seconds are optional (`"2026-09-03T09:00:30"` fires at that second);
    the web form writes minute precision.

  An optional `timezone` (IANA name, e.g. `"America/New_York"`) applies
  to every spelling — the pattern fires there, English times apply
  there, and a zone-less one-shot datetime is read as wall-clock time
  there.

- **Missed runs fire on the next start.** If an occurrence’s moment
  passes while `serve` is not running — the machine was asleep or
  rebooted, the process was down — the next start fires it once,
  immediately: the **most recent** missed occurrence, however many piled
  up (a month-long outage against an hourly job still fires exactly
  once, never a burst). A paused job catches up the same way when
  resumed — *paused* means “not now”, not “never”. Each row remembers
  its last served occurrence (`last_fired_at`), so a restart right after
  a fire never fires twice, and an edit or rename never re-fires
  anything. Disabled jobs never catch up: a disabled one-shot whose
  moment passed is removed without running.

In the web form you can also **type a schedule in English** —
`every weekday at 9:00`, `at 9:00` (daily), `on sunday at 18:00`,
`every 30 minutes`, `every 2 hours`,
`on the last day of the month at 18:00`. It is translated by
[@breejs/later](https://github.com/breejs/later) into the equivalent
cron pattern, and the **cron pattern is what gets saved**
(`every weekday at 9:00` → `"0 9 * * 1-5"`); the live preview shows the
conversion before you save. English hand-written in a migrated config
file also still works — it is translated the same way at serve boot.
Phrasings that would fire more often than once a minute are rejected.

- Every fire starts a **new session** in `workingDir` with `prompt`, and
  it shows up in the sidebar like any other session — badged with a
  clock chip naming the job, in the sidebar and the transcript header. A
  fire whose session is still being established skips the next tick
  rather than piling runs onto the same directory.

- `modelProvider`/`model` (goose flavor only, both keys together) pin
  every fire of the job to that model — the web form’s schedule dialog
  has its own model picker with the same options as the New Session
  form; omit both keys to run the agent’s default. The pin is validated
  when you save, and serve refuses to start when a job pins a model the
  flavor can’t take (claude) or sets only one of the two keys.

- `name` must be unique (every stored job is named; entries migrated
  from an unnamed config-file slot get `cron-1`, `cron-2`, …);
  `timezone` defaults to system-local time; `enabled: false` pauses a
  job without deleting it.

- Jobs are validated at `serve` startup — an invalid job (bad schedule,
  unknown timezone, duplicate name, or a missing working directory on an
  enabled job) stops the server from starting, naming the job.

- `serve` also **watches the cron database and reloads the schedule
  live**: added, changed, and removed jobs take effect without a
  restart. Edits from the web UI apply immediately; edits from other
  processes (direct sqlite3 use, a future cron CLI) land within one poll
  interval (`GLV_CRON_DB_POLL_MS`, default 5000). A reload only swaps
  the schedule once the whole new job set validates — an invalid edit (a
  row with a bad schedule, …) is logged to stderr and the previous
  schedule keeps running until the table holds a valid set again. Runs
  already in flight when their job is removed or changed are left to
  finish. A one-shot whose moment already passed — at boot or in a
  reload — is retired without running: a missed moment stays missed.

- `GLV_CRON_SESSION_TIMEOUT_MS` (default 60000) bounds how long a fire
  waits for the agent to create its session before the run is stopped.

## Authentication

The web viewer is protected by **passkey authentication** (WebAuthn) —
no emails, no passwords. The first person to visit a freshly started
viewer creates a passkey and permanently claims the app; every
subsequent registration attempt is blocked. The authorized user can log
back in at any time with a quick passkey tap.

- **Auth database** — passkey credentials and login sessions live in a
  separate SQLite database at `~/.local/share/glv-goose/auth.db` on
  Linux/macOS (`%APPDATA%\glv-goose\auth.db` on Windows) for the goose
  flavor, and the same path under `glv-claude` for the claude flavor —
  fully independent of the agent’s session data. Override with
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

### Registering a new domain

A passkey is cryptographically bound to the domain (Relying Party ID) it
was created on, so one made on `localhost` cannot unlock a different
domain, and vice versa. To sign in from more than one origin — for
example your local machine *and* a deployed host — register a separate
passkey for each via the single-use **enrollment** flow:

1.  Log in on an origin you already have a passkey for
    (e.g. `http://localhost:3000`).
2.  Visit `/auth/devices` and click **Add a passkey for another device
    or domain**. The viewer mints a one-time enrollment link.
3.  Open that link on the new domain — for another host, swap the
    `localhost` part for your domain
    (e.g. `https://your-host.example/auth/enroll/<token>`). Complete the
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
>     proxy_set_header Host $host;
>     proxy_set_header X-Forwarded-Host $host;
>     proxy_set_header X-Forwarded-Proto $scheme;

## Development

``` bash
pnpm install
pnpm build    # type-check + compile the Tailwind stylesheet
pnpm test     # run tests
pnpm lint     # lint all files
```

Build and lint are fast — run both locally before every push. The test
suite is slow (every file boots a real `glv serve` process plus a
headless Chromium), so testing is split by pull-request state: run
`pnpm test` locally **before opening a pull request**, and once a PR is
open let CI do the testing — it exercises the suite on Linux and Windows
on every push (`.github/workflows/ci.yml`), so don’t re-run it locally
per iteration; watch the PR checks instead. While no PR is open, testing
stays local. One caveat on Windows: the claude-flavored suites that
spawn the mocked agent binary are excluded (see `vitest.config.ts` for
why); they still run there through the goose flavor, which drives the
same core.

Every test file boots a real `glv serve` process plus a headless
Chromium, so the suite runs at most two files at a time to keep peak
memory in check on local machines.

`pnpm test` collects coverage across those spawned processes, not just
the in-process test files: each launcher is pointed at Node’s built-in
V8 profiler (`NODE_V8_COVERAGE`) and a load hook records the tsx
transforms, so the vitest report includes the server, runner, and view
code the suite actually drives (see
`src/glv/tests/subprocess- coverage.ts` for the pipeline). Coverage
floors live in `vitest.config.ts`. A bare `vitest run --coverage`
reports only in-process code. Serve-process coverage requires a graceful
exit to flush profiles; Node’s `kill()` on Windows terminates
unconditionally, so there it is limited to CLI invocations (which exit
normally) and the propagation suites are skipped — see the exclusion
list in `vitest.config.ts`.

The repository hosts two viewers with parallel structure: `src/goose/`
(goose sessions) and `src/claude/` (claude sessions), both on top of the
shared core in `src/glv/`. Each is styled with [Tailwind CSS
v4](https://tailwindcss.com): the stylesheet source
(`src/<app>/styles/app.css`) uses Tailwind’s CSS-first setup —
`@import "tailwindcss"` plus a `@theme` block of design tokens — and is
compiled to `dist/<app>/app.css` by `pnpm build:assets` (see
`src/<app>/build.ts`). Browser client scripts are written as TypeScript
in `src/<app>/scripts/` and compiled to minified `dist/<app>/*.js` by
the same command. The goose viewer is launched with `glv-goose` and the
claude viewer with `glv-claude`.

## The CLI

Everything above is driven by the flavor launchers, which also offer a
few lightweight terminal commands for quick lookups without opening a
browser:

``` bash
glv-goose sessions      # list recent sessions
glv-goose view <id>     # show prompts + outputs for a session
glv-goose logs          # list --no-session runs
```

`glv-claude` takes the same `sessions` and `view` commands (`logs` is
goose-only).
