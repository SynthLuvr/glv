# Guided Live Velocity

A self-hosted web app that **increases your development speed with
agentic coding**. Guided Live Velocity drives the
[goose](https://github.com/block/goose) agentic engine from a fast
browser UI: launch guided coding sessions, watch them stream live, and
turn raw transcripts into navigable, searchable velocity.

goose records every session — prompts, model responses, tool calls, and
reasoning — in an on-disk SQLite database. **Guided Live Velocity** (or
**glv**) turns that database into a fast, self-hosted web UI: browse
past sessions, watch live runs stream in real time, kick off fresh runs,
and even launch goose against a GitHub repository — all without leaving
the browser.

## Why

- **Ship faster with agentic coding.** Guided Live Velocity puts the
  goose agentic engine behind one fast UI, so you spend less time
  juggling terminals and more time shipping guided, live-streamed
  sessions.
- **Make your session history navigable.** goose’s transcripts are rich
  (markdown, tool calls, thinking blocks, token usage), but they live in
  a database that is hard to read directly. glv renders them as a clean,
  searchable web transcript.
- **Run goose from a UI.** Instead of juggling terminals, start a new
  `goose run` from a form, queue follow-up prompts, and watch the output
  stream live — on one machine or many.
- **Safe to use alongside goose.** Browsing is read-only, and the only
  writes are viewer-side archive/rename metadata — never to the live
  session data a running goose session is using.
- **Private by design.** The viewer is protected by passkey
  authentication and runs entirely on your own machine.

## Features

- **Session browser.** A sidebar lists every goose session with its
  name, working directory, provider, token count, and last-updated time.
  Select one to read the full transcript of prompts and outputs.
- **Live streaming.** Start a run in the viewer and its output streams
  in real time via Server-Sent Events. The session appears in the
  sidebar the moment goose writes it.
- **New sessions.** A `+` button opens a form to start a fresh goose
  run. Pick a **working directory** on disk, or point goose at a
  **GitHub repository** — glv clones the repo (using your existing `gh`
  auth) and runs goose against it.
- **Queued follow-ups.** While a session is running you can queue
  follow-up prompts that chain together once the current run finishes.
  Runs are governed by a concurrency-limited queue (six by default).
- **Tail external sessions.** Sessions started from the terminal,
  desktop, or another CLI are tracked too — glv polls the shared
  database and streams only the deltas, so you can keep an eye on a run
  from anywhere.
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
  Each job can pin the model its runs use (goose or a claude alias).
- **Suggested next prompts.** When a session finishes a turn, GLV can
  quietly ask the same assistant for a few good follow-up prompts and
  offer them as one-tap suggestions above the input box. The ask is
  tiny (just the tail of the conversation), happens at most once per
  finished turn, never occupies the queue real prompts use, and leaves
  no session behind — no sidebar entry, no transcript, no activity.
  Opt-in: the lightbulb switch in the sidebar header turns it on and
  off (off by default).
- **Session management.** Rename sessions, fork a session — the whole
  transcript or from any message boundary — to explore a branch without
  touching the original (forks are ordinary sessions: rename, archive,
  delete, fork again), and archive one at a time or in bulk.
- **Dark and light themes.**
- **Passkey login.** The whole app is gated behind WebAuthn passkey
  authentication — no emails, no passwords.

## How it works

glv is a single Node.js process built on the
[Fastify](https://fastify.dev) web framework (views rendered with
`hono/jsx`):

- **Reads goose’s database directly.** Sessions are read from the goose
  SQLite database at `~/.local/share/goose/sessions/sessions.db`.
  Browsing opens the database **read-only** — the only writes are
  viewer-managed archive and rename metadata, routed through a separate
  writable connection, and they never touch the rows a running goose
  session reads, so it is always safe while goose is running.
- **Server-rendered with interactivity.** Pages are rendered server-side
  with `hono/jsx` and updated incrementally with
  [htmx](https://htmx.org) — there is no client-side SPA to build or
  ship. Styling is [Tailwind CSS v4](https://tailwindcss.com).
- **A runner spawns goose.** When you start or resume a session, glv
  spawns a `goose run` subprocess, feeds the prompt over stdin, and
  parses the `stream-json` output. A `p-queue` caps how many goose
  processes run at once; surplus prompts are queued and chained
  automatically.
- **Live updates over SSE.** Active runs stream through
  `/sessions/:id/stream`; sessions started elsewhere are followed via
  `/sessions/:id/tail`, which polls the shared database for new and
  edited messages.
- **Sanitized output.** All model and tool output is rendered as GitHub-
  Flavored Markdown and sanitized with DOMPurify before it reaches the
  browser.

## Setup

``` bash
node scripts/setup.mjs
```

This installs dependencies and installs the `glv` launcher onto your
PATH (`~/.local/bin/glv` on macOS/Linux,
`%USERPROFILE%\.local\bin\glv.cmd` on Windows). `./setup.sh` remains as
a thin Unix wrapper. Re-running is safe.

One `glv` command serves **both** agents: `glv serve` shows goose and
claude sessions in one sidebar, behind one login and one schedule — an
agent whose binary or data directory is missing is hidden, not fatal
(see `docs/decisions/0007-merge-goose-and-claude.md`). There is no
agent-choice flag: both agents always load, and the per-flavor commands
`glv-goose` / `glv-claude` are gone. Older glv adopted the per-flavor
data directories (`~/.local/share/glv-goose`, `glv-claude`) into the
unified `~/.local/share/glv` on its first starts; that migration is
complete and the code is gone. Current glv never reads the legacy
directories — a leftover `glv-goose.migrated` or `glv-claude.migrated`
can simply be deleted.

### Windows

`node scripts\setup.mjs` does the same on Windows: it installs
dependencies and writes a `%USERPROFILE%\.local\bin\glv.cmd` shim. If
setup warns that the folder is not on your `PATH`, add it (Settings →
System → About → Advanced system settings → Environment Variables) and
open a new terminal; `glv serve` then works from anywhere.

You can also skip the shim and invoke the launcher with Node directly —
this is exactly what the shim runs:

``` powershell
node bin\glv.mjs serve -p 3001
```

Windows notes:

- The launcher hands its TypeScript loader to `node --import` as a
  `file://` URL. A plain `C:\...` path there is rejected by Node’s ESM
  loader (`ERR_UNSUPPORTED_ESM_URL_SCHEME`), so keep the launcher as the
  entry point rather than re-creating the `node --import` chain by hand.
- glv reads goose’s sessions database from goose’s own platform-default
  location: `%APPDATA%\Block\goose\data\sessions\sessions.db` on Windows
  and `~/.local/share/goose/sessions/sessions.db` on Linux/macOS. Point
  glv at a different file with `--goose-db <path>` or the
  `GOOSE_SESSIONS_DB` environment variable; claude’s transcripts root is
  `--projects-dir <path>`.
- glv-owned data (the auth database, prompt library, scheduled runs, and
  uploads) lives under `%APPDATA%\glv` (`~/.local/share/glv` on
  Linux/macOS). All of it is overridable — see the flags below.

### Prerequisites

- **Node.js ≥ 24** and **pnpm ≥ 10**.
- The **`goose`** binary on your `PATH` (to start new runs from the
  viewer).
- The **`gh`** CLI, authenticated, to use the GitHub repository source
  and PR status features.
- **pandoc ≥ 3.10** (only needed for the Markdown lint/format check
  during development).

The toolchain runs on Linux, macOS, and Windows; line endings are
normalized to LF via `.gitattributes`, and pandoc is invoked with
`--eol=lf` so its output stays LF on Windows too.

## Running the web viewer

``` bash
glv serve
```

Open the printed URL (e.g. <http://localhost:3000>). The first visitor
is prompted to create a passkey and permanently claims the app. Sessions
from both agents appear in one sidebar; an agent whose binary or data
directory is missing is simply absent.

Options:

- `-p, --port <number>` — port to listen on (default `3000`).

- `-c, --max-concurrent <number>` — maximum concurrent agent runs driven
  from the viewer, across both agents (default `6`).

- `--goose-binary <path>` — path to the `goose` binary used to run
  prompts (default `goose` on `PATH`).

- `--claude-binary <path>` — path to the `claude` binary (default
  `claude` on `PATH`).

- `--permission-mode <mode>` — claude permission mode for glv-launched
  runs (default `inherit`, deferring to your claude settings.json).

- `--goose-db <path>` — override the goose sessions database location
  (or `GOOSE_SESSIONS_DB`).

- `--projects-dir <path>` — override claude’s transcripts root (or
  `CLAUDE_CONFIG_DIR`).

- `--auth-db <path>` — override the auth database location (default
  `~/.local/share/glv/auth.db` on Linux/macOS (`%APPDATA%\glv\auth.db`
  on Windows), or `GLV_AUTH_DB`).

- `--cron-db <path>` — override the scheduled runs database location
  (default `~/.local/share/glv/cron.db` on Linux/macOS
  (`%APPDATA%\glv\cron.db` on Windows), or `GLV_CRON_DB`).

- `--suggestions-db <path>` — override the suggested-next-prompts
  database location (default `~/.local/share/glv/suggestions.db` on
  Linux/macOS (`%APPDATA%\glv\suggestions.db` on Windows), or
  `GLV_SUGGESTIONS_DB`).

- `--suggestions-model <value>` — pin the model suggestion asks use, in
  the combined picker spelling (e.g. `claude:haiku`); by default each
  agent answers on its own configured model.

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
lists every job with pause, edit, and delete). Scripts and CI can
create, list, and delete the same jobs over the JSON API
([below](#scheduling-runs-over-the-api)). The jobs live in the **cron
database** — a glv-owned SQLite file at `~/.local/share/glv/cron.db` on
Linux/macOS (`%APPDATA%\glv\cron.db` on Windows), alongside the
job-started-session tags that badge fired runs. Override with
`--cron-db <path>` or the `GLV_CRON_DB` environment variable. The
running server picks changes up live, no restart needed.

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

- `modelProvider`/`model` (both keys together) pin every fire of the job
  to that model — goose takes a provider/model pair, claude an alias;
  omit both keys to run the agent’s default. The pin is validated when
  you save, and serve refuses to start when a job pins a model the agent
  can’t take or sets only one of the two keys.

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
  separate SQLite database at `~/.local/share/glv/auth.db` on
  Linux/macOS (`%APPDATA%\glv\auth.db` on Windows), fully independent of
  the goose sessions database. Override with `--auth-db <path>` or the
  `GLV_AUTH_DB` environment variable.
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

### API tokens (curl, CI)

A passkey ceremony needs a browser, so scripts and CI get their own
credential minted *underneath* the passkey: log in once in the browser,
visit `/auth/tokens`, name a token, and copy the `glv_at_…` value — it
is displayed exactly once and only its SHA-256 hash is stored. Tokens
live 30 days (no sliding renewal), record their `last_used_at` time, and
can be revoked on the same page.

``` bash
curl -sS -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/api/sessions
curl -sS -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/api/sessions/goose:abc123
curl -N -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/events/status
```

The session cookie also works for `/api/*`, but exporting it to scripts
couples them to your browser login (7-day ceiling, revoked on logout,
indistinguishable from you) — mint a token instead.

### Driving runs over the API

The listing paginates: `?limit=` (1–500, default 100) and `?offset=`
window the newest-first order.

The non-destructive mutations the browser can perform are JSON endpoints
too, with identical semantics (both surfaces delegate to one shared
operation layer). **`POST` accepts the bearer only** — a
cookie-authenticated write is rejected with `401`, which is what makes
these endpoints safe behind an app that ships no CSRF protection:

| Endpoint | Effect |
|----|----|
| `POST /api/sessions` | start a run (multipart form) |
| `POST /api/sessions/:id/prompt` | queue a follow-up prompt |
| `POST /api/sessions/:id/stop` | stop the run (idempotent: `200` either way) |
| `POST /api/sessions/:id/fork` | copy the session under a fresh id |

Start a session in a working directory — or send `session_mode=temp`
instead of `working_dir` for a scratch directory glv owns and sweeps on
archive:

``` bash
curl -sS -X POST http://localhost:3457/api/sessions \
  -H "Authorization: Bearer glv_at_…" \
  -F prompt="summarize the failing tests" \
  -F working_dir="$PWD" \
  -F uploads=@error.log
```

The answer is `201` with a `Location` header and
`{"id":"goose:…","status":"started"}`. `"queued"` means the prompt is
waiting — behind the concurrency pool for a new session, behind the
session’s active run for a follow-up. Creation returns once the session
exists, not when the run completes: poll the detail endpoint, or watch
the run live over the session’s SSE feed (the same feed the browser
uses, and the same bearer header):

``` bash
curl -sS -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/api/sessions/goose:abc123

curl -N -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/sessions/goose:abc123/events
```

Queue a follow-up while it runs, and stop a runaway:

``` bash
curl -sS -X POST http://localhost:3457/api/sessions/goose:abc123/prompt \
  -H "Authorization: Bearer glv_at_…" \
  -F prompt="now fix them"

curl -sS -X POST http://localhost:3457/api/sessions/goose:abc123/stop \
  -H "Authorization: Bearer glv_at_…"
```

Fork a session — the whole transcript, or only the messages up to a
boundary — and optionally give the copy a first prompt in the same
request (it runs through the follow-up path, so the fork resumes as an
ordinary session):

``` bash
curl -sS -X POST http://localhost:3457/api/sessions/goose:abc123/fork \
  -H "Authorization: Bearer glv_at_…" \
  -F cutoff=1 \
  -F prompt="try a different approach from here"
```

The answer is `201` with the new session’s id and `{"status":"created"}`
(no prompt) or `{"status":"started"|"queued"}` (prompt riding the
follow-up path). `cutoff` is the index of the last message to keep, in
transcript order — the same boundary the per-message fork button posts.
A cutoff that would strand a tool call without its result is rejected
with `422`; the source is never modified in any case.

Optional `POST /api/sessions` fields: `model` (`agent:provider:model`,
omitted or empty for the agent’s default), `location` (the JSON
coordinate share the browser sends), and `uploads` (files, appended to
the prompt as readable paths). Validation failures answer
`422 {"error":"…"}`; unknown ids `404`.

`GET /api/openapi.json` serves the machine-readable contract — generated
from the same schemas the routes validate with, so it cannot drift —
behind the same auth as every other `/api` path. Destructive operations
(archive, delete) and every management surface (tokens, prompts, groups)
stay in the browser.

### Scheduling runs over the API

Scheduled runs are scriptable too — the same schedule grammar the
browser form accepts (a one-shot ISO datetime, a cron pattern, or
English text), written through the same operation layer, landing in the
same cron database and picked up by the running scheduler immediately:

| Endpoint                 | Effect                                       |
|--------------------------|----------------------------------------------|
| `GET /api/cron`          | list scheduled runs (creation order)         |
| `GET /api/cron/:name`    | read one run                                 |
| `POST /api/cron`         | schedule a run (multipart form, bearer only) |
| `DELETE /api/cron/:name` | cancel a run                                 |

Schedule a one-off — the programmatic answer to “run this once at 09:00”
from CI or a deploy script:

``` bash
curl -sS -X POST http://localhost:3457/api/cron \
  -H "Authorization: Bearer glv_at_…" \
  -F name="release-notes" \
  -F schedule="2026-10-01T09:00" \
  -F prompt="draft the release notes" \
  -F working_dir="$PWD"
```

The answer is `201` with a `Location` header and the stored row; a
one-shot carries a single `next_runs` instant, fires once, and retires
itself from the listing afterwards. Recurring spellings —
`schedule="0 9 * * 1-5"` or `schedule="every weekday at 9:00"` — work
the same way (English is stored as its cron translation with the typed
text kept in `schedule_input`). Optional fields: `timezone` (IANA name
the schedule’s times apply in), `model` (`agent:provider:model`, same
spelling as the session API), and repeated `follow_ups` parts chaining
further prompts after the first (10 steps in total, at most). Every row
carries `next_runs` — the next fire times — while it is enabled. Cancel
anything that has not fired yet:

``` bash
curl -sS -X DELETE http://localhost:3457/api/cron/release-notes \
  -H "Authorization: Bearer glv_at_…"
```

Names may contain spaces (URL-encode them); validation failures answer
`422 {"error":"…"}`, unknown names `404`.

> **Behind a reverse proxy.** When the viewer sits behind a
> TLS-terminating proxy, forward the original request details so
> WebAuthn computes the correct RP origin and cookie flags:
>
>     proxy_set_header Host $host;
>     proxy_set_header X-Forwarded-Host $host;
>     proxy_set_header X-Forwarded-Proto $scheme;
>
> Raise the proxy’s body-size limit to match glv’s upload limits (50 MB
> per file, 100 MB total), too: proxies apply their own much smaller
> default (nginx: 1 MB) and reject larger uploads with a bare 413 before
> glv sees the request:
>
>     client_max_body_size 110m;

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
(goose sessions) and `src/claude/` (claude sessions). Each is styled
with [Tailwind CSS v4](https://tailwindcss.com): the stylesheet source
(`src/<app>/styles/app.css`) uses Tailwind’s CSS-first setup —
`@import "tailwindcss"` plus a `@theme` block of design tokens — and is
compiled to `dist/<app>/app.css` by `pnpm build:assets` (see
`src/<app>/build.ts`). Browser client scripts are written as TypeScript
in `src/<app>/scripts/` and compiled to minified `dist/<app>/*.js` by
the same command. The two flavor trees remain as adapters (profile,
store, launcher, argv builder, fixtures); the product itself — one
server, one sidebar, one schedule serving both agents — is launched with
`glv`.

## The CLI

Everything above is driven by the `glv` command, which also offers a few
lightweight terminal commands for quick lookups without opening a
browser:

``` bash
glv sessions      # list recent sessions (ids namespaced per agent)
glv view <id>     # show prompts + outputs for a session
glv logs          # list goose --no-session runs
```
