# glv

[![CI](https://github.com/SynthLuvr/glv/actions/workflows/ci.yml/badge.svg)](https://github.com/SynthLuvr/glv/actions/workflows/ci.yml)

A self-hosted web app that **increases your development speed with
agentic coding**. glv (short for Guided Live Velocity) drives the
[goose](https://github.com/aaif-goose/goose) agentic engine from a fast
browser UI: launch guided coding sessions, watch them stream live, and
turn raw transcripts into navigable, searchable velocity.

goose records every session — prompts, model responses, tool calls, and
reasoning — in an on-disk SQLite database. **glv** turns that database
into a fast, self-hosted web UI: browse past sessions, watch live runs
stream in real time, kick off fresh runs, and even launch goose against
a GitHub repository — all without leaving the browser.

## Screenshots

A session transcript — prompt, streamed output, and one-tap suggested
follow-ups — in the light theme:

<img src="https://github.com/user-attachments/assets/6c4da68c-5067-4591-aad6-3d9209537f74" alt="A goose session transcript in the glv web UI, light theme" />

The same session in the dark theme, mid-run with a queued follow-up:

<img src="https://github.com/user-attachments/assets/3cbe55e2-91f3-4297-95aa-724253af8725" alt="A goose session in the dark theme, mid-run with a queued follow-up" />

The scheduled-runs form: plain-English or cron schedules, validated
live, with the upcoming runs previewed:

<img src="https://github.com/user-attachments/assets/8750df4b-c958-41af-b05b-34f36b5f5aa3" alt="The glv scheduled-runs form with timezone, model, and next-runs preview" />

## Why

- **Ship faster with agentic coding.** glv puts the goose agentic engine
  behind one fast UI, so you spend less time juggling terminals and more
  time shipping guided, live-streamed sessions.
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
- **Stop-early notices.** When the provider refuses to serve a session —
  a usage limit (reset time included) or a network outage — the session
  view says why the run stopped early and that sending a message
  continues it. The notice survives closing and reopening the session
  and clears itself once the session runs again.
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
- **Suggested next prompts.** When a session finishes a turn, GLV
  quietly asks the same assistant for a few good follow-up prompts and
  offers them as one-tap suggestions above the input box. The ask is
  tiny and grounded — the session’s goal, what the agent just did
  (commands, files), the last failure, and the conversation tail —
  happens at most once per finished turn, never occupies the queue real
  prompts use, and leaves no session behind — no sidebar entry, no
  transcript, no activity.
- **Session management.** Rename sessions, fork a session — the whole
  transcript or from any message boundary — to explore a branch without
  touching the original (forks are ordinary sessions: rename, archive,
  delete, fork again), and archive one at a time or in bulk.
- **Prompt library.** Save reusable prompts — title, body, optional
  category — then fill the prompt box or run one directly from the
  library. Cards drag to reorder, can sort by manual order or usage, and
  usage counts accumulate; everything lives in glv’s own database, safe
  alongside the agents’ session data.
- **Session groups.** Group related sessions under one collapsible
  sidebar section whose header shows a running indicator while any
  member runs. Archiving a member hides it but keeps its membership —
  un-archive it and the group is restored.
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

Clone the repository, then run the setup script — glv is distributed as
source only, with no published npm package, so cloning is the install:

``` bash
git clone https://github.com/SynthLuvr/glv.git
cd glv
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

- **Node.js ≥ 26** — the floor `package.json`’s `engines` requires; CI
  installs 26.
- **pnpm ≥ 12** — the repo pins the exact version via `packageManager`
  (currently `pnpm@12.11.2`); Corepack honors the pin automatically.
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

- A run whose agent emits **no output at all** within the startup
  deadline (default 300000 ms, override with `GLV_STARTUP_TIMEOUT_MS`)
  is failed with a diagnostic and its process tree killed — an agent
  parked in startup (a hung extension) can no longer hold a concurrency
  slot forever and leave an empty session behind. The first output line
  disarms the deadline; long runs are never cut short by it. Every run
  spawn and exit is logged (agent, session, pid, exit code or signal)
  alongside the cron lifecycle lines.

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

- `--stop-notices-db <path>` — override the stop-notice database
  location (default `~/.local/share/glv/stop-notices.db` on Linux/macOS
  (`%APPDATA%\glv\stop-notices.db` on Windows), or
  `GLV_STOP_NOTICES_DB`). When a run ends early — the provider refused
  service (a usage limit with its reset time, a network outage) or the
  agent itself failed (a crash exit, a signal death, a stalled startup)
  — the session view explains why and that sending a message continues
  it; the notice (the exit verdict plus the agent’s last stderr lines,
  where relevant) survives reloads and restarts and clears itself once
  the session runs again.

- `--prompts-db <path>`, `--groups-db <path>`, `--meta-db <path>` —
  override the remaining glv-owned databases the same way: the saved
  prompt library, the session groups, and the claude viewer metadata
  (defaults `~/.local/share/glv/prompts.db`, `groups.db`,
  `claude-meta.db` on Linux/macOS, `%APPDATA%\glv\…` on Windows, or env
  `GLV_PROMPTS_DB`, `GLV_GROUPS_DB`, `GLV_META_DB`).

- `--rp-name <name>` — WebAuthn relying party name shown in the OS
  passkey prompt (default `GLV`).

- `--rp-id <domain>` — WebAuthn relying party ID; must match the domain
  the browser uses (defaults to the request host, e.g. `localhost`).

- `--debug` — enable debug logging (equivalent to `GLV_DEBUG=1`).

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
lists every job with **run now** (fires the job immediately, schedule
unaffected — a paused job can be run without resuming it), pause, edit,
and delete). Scripts and CI can create, list, and delete the same jobs
over the JSON API ([below](#scheduling-runs-over-the-api)). The jobs
live in the **cron database** — a glv-owned SQLite file at
`~/.local/share/glv/cron.db` on Linux/macOS (`%APPDATA%\glv\cron.db` on
Windows), alongside the job-started-session tags that badge fired runs.
Override with `--cron-db <path>` or the `GLV_CRON_DB` environment
variable. The running server picks changes up live, no restart needed.

Jobs written by hand (or by an older glv) as a `cronJobs` array in the
retired config file were migrated into the cron database by the first
`serve` starts after that file’s retirement — entries won on a name
collision, so nothing was duplicated. Current glv never reads the file,
and a stray `cronJobs` key is inert.

- `schedule` is one of two spellings:

  - a [croner](https://github.com/hexagon/croner) pattern — the usual
    5-field cron (`"0 9 * * 1-5"`), 6 fields with a leading seconds
    part, or a nickname like `"@daily"`. croner’s stable line is 10.x;
    glv pins an 11.0.0 dev build for the timer fix it carries, and the
    pin moves to the stable 11 release once that ships.
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

- **Run now** — the section’s button, or `POST /api/cron/:name/run` —
  fires the stored row immediately through the same path a scheduled
  tick takes: prompt, working directory, model pin, and follow-on chain
  all apply, and a previous fire still in flight is refused rather than
  stacked. The schedule is unaffected — a recurring job keeps its times,
  and a not-yet-due one-shot keeps its appointment (only a fire served
  at or after its own moment retires a one-shot). A paused job can be
  run without resuming it, but its working directory must exist.

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

### Suggested next prompts

The feature is always on: when a session finishes a turn, the
suggestions arrive on their own — there is nothing to switch.

The model the background asks use is configured in the suggestions
database, not a flag — one `settings` row, in the combined picker
spelling, read fresh so an edit applies without a restart:

``` sh
sqlite3 ~/.local/share/glv/suggestions.db \
  "INSERT INTO settings (key, value) VALUES ('model', 'claude:claude:haiku') \
   ON CONFLICT(key) DO UPDATE SET value = excluded.value"
```

A blank or missing value asks on each agent’s own default (goose: the
default its config resolves).

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

A passkey ceremony needs a browser, so scripts, CI, and agents get their
own credential minted *underneath* the passkey. Three surfaces mint the
same credential against the same auth database:

- **In the browser** — log in once, visit `/auth/tokens`, name a token,
  and copy the `glv_at_…` value.

- **From the shell** — `glv token create --name "orchestrator-loop"`
  prints the raw token as its entire stdout, so a script or agent can
  capture it directly (`TOKEN=$(glv token create --name ci)`). The same
  data-dir resolution the other subcommands use applies (`--auth-db` or
  `GLV_AUTH_DB`), so it works wherever `serve` reads its users.

  ``` bash
  glv token create --name "orchestrator-loop"  # prints the token once
  glv token list                               # id, name, created, last used, expires
  glv token revoke <id>                        # id from `glv token list`
  ```

- **Over HTTP, from the machine running `serve`** — for agents with
  network reach to the viewer but *no* filesystem access to the data
  directory (SSH port-forwards, sibling containers, CI executors). Start
  serve with `--allow-token-bootstrap` and a loopback peer may mint
  without any credential — a credential is exactly what it is minting:

  ``` bash
  curl -sS -X POST http://localhost:3457/api/tokens \
    -H 'content-type: application/json' -d '{"name":"remote agent"}'
  # → 201 {"token":"glv_at_…","name":"remote agent"}
  ```

  The endpoint is **off by default** — without the flag
  `POST /api/tokens` answers exactly like any unknown `/api` path. When
  on, the decision is the **TCP peer’s socket address**: `127.0.0.1` /
  `::1` only. `x-forwarded-*` headers are never consulted, and that is
  why **you must not enable the flag behind a reverse proxy**: every
  proxied request arrives from the proxy’s own loopback hop, which would
  make minting world-open (serve warns about this at every boot the flag
  is on). Minting is bounded to 10 tokens per rolling minute and still
  requires the app to have an owner.

Either way the `glv_at_…` value is displayed exactly once and only its
SHA-256 hash is stored — revoking by that hash from any surface kills
the credential. Minting requires the app to have an owner (a passkey
registered once in the browser); tokens live 30 days (no sliding
renewal), record their `last_used_at` time, and a token still grants
only the single owner’s identity — the CLI and the loopback bootstrap
widen *who can mint*, from the machine that already owns the data
directory (the CLI) or can reach its loopback (the bootstrap).

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

The whole loop a driving agent needs is now shell-only — the token
bootstrap included (mint it with `glv token create`, above, or — with no
filesystem access to the data dir — with the loopback-only
`--allow-token-bootstrap` endpoint; the app must already have a
passkey-registered owner):

``` bash
TOKEN=$(glv token create --name "orchestrator-loop")   # mint once, capture
BASE=http://localhost:3457

# start a run — name and model are optional; model takes the picker
# spelling (agent:provider:model, listed by GET /api/models)
ID=$(curl -sS -X POST "$BASE/api/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -F prompt="address issue #57" -F working_dir="$PWD" \
  -F name="issue #57 fix" | jq -r .id)

# wait for it to settle, then read the verdict
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions/$ID/wait" \
  | jq '{status, last_run}'
```

The listing paginates and filters server-side: `?limit=` (1–500, default
100) and `?offset=` window the newest-first order, and three filters
narrow it — every one applies *before* the window, so pagination pages
the filtered order exactly as it pages the unfiltered one:

- `?working_dir=<dir>` — only sessions in that directory: a row’s
  `working_dir` equals it or lies underneath it. A trailing slash is
  tolerated; a sibling directory that merely shares a stem does not
  match.
- `?agent=goose|claude` — only one served agent’s sessions (anything
  else answers `422` naming the agents this server serves).
- `?active=true` — only sessions with a live run (`queued` or
  `running`), the same set the `/events/status` sync snapshot carries.
  `false` reads as absent.

``` bash
# what is running in this repo right now
curl -sS -H "Authorization: Bearer glv_at_…" \
  "http://localhost:3457/api/sessions?working_dir=$PWD&active=true"
```

The detail read has its own windows: `?fields=meta` answers with the
session row and no transcript, and `?after=<message-index>` answers with
only the messages from that transcript index on — see [Polling without
re-downloading the
transcript](#polling-without-re-downloading-the-transcript) below.

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
| `POST /api/prompts` | save a prompt to the library (see below) |
| `PUT /api/prompts/:id` | update a saved prompt (see below) |

Start a session in a working directory — or send `session_mode=temp`
instead of `working_dir` for a scratch directory glv owns and sweeps on
archive:

``` bash
curl -sS -X POST http://localhost:3457/api/sessions \
  -H "Authorization: Bearer glv_at_…" \
  -F prompt="summarize the failing tests" \
  -F working_dir="$PWD" \
  -F name="issue #57 fix" \
  -F uploads=@error.log
```

An optional non-blank `name` labels the session at creation — the same
viewer-managed rename the browser’s rename action performs — so a driven
loop starting several runs can tell them apart before any agent-derived
title arrives. Absent or blank keeps auto-derived naming.

The answer is `201` with a `Location` header and
`{"id":"goose:…","status":"started"}`. `"queued"` means the prompt is
waiting — behind the concurrency pool for a new session, behind the
session’s active run for a follow-up. Creation returns once the session
exists, not when the run completes: park on the wait endpoint (below —
it resolves the moment the run settles), poll the detail endpoint, or
watch the run live over the session’s SSE feed (the same feed the
browser uses, and the same bearer header):

``` bash
curl -sS -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/api/sessions/goose:abc123

curl -N -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/sessions/goose:abc123/events
```

Every timestamp the API returns — a session row’s `created_at`,
`updated_at`, and `archived_at`, each message’s `timestamp`,
`last_run.ended_at`, `last_fired_at` — is ISO 8601 UTC with an explicit
`Z` designator: `2026-10-21T18:22:36Z`. Storage is UTC and the wire says
so, because most parsers read a bare `2026-10-21 18:22:36` as *local*
time.

Every session row the API returns — the detail endpoint’s `session`
object and each listing row — carries a `status` field naming the run’s
state, so a polling script never has to infer it:

| `status`    | Meaning                              |
|-------------|--------------------------------------|
| `queued`    | the run waits for a concurrency slot |
| `running`   | the run is executing                 |
| `completed` | the run finished normally            |
| `stopped`   | the run was stopped                  |
| `error`     | the run failed                       |
| `idle`      | no run is registered                 |

A terminal status (`completed`, `stopped`, `error`) is visible for the
short window a settled run lingers in the runner’s registry (about 30
s), then reads `idle` — poll at a steady cadence to catch how a run
ended. `idle` means no run is registered at all; a hung run stays
`running`, exactly like a healthy one — only the SSE feed shows live
progress. To wait for a run from a script, prefer the wait endpoint
below; the poll loop is the fallback for environments that cannot hold a
connection open:

``` bash
while :; do
  s=$(curl -sS -H "Authorization: Bearer glv_at_…" \
    "http://localhost:3457/api/sessions/goose:abc123?fields=meta" \
    | jq -r .session.status)
  case "$s" in running | queued) sleep 2 ;; *) break ;; esac
done
```

#### Waiting for a run without polling

`GET /api/sessions/:id/wait?timeout=<ms>` is the wait primitive: the
request parks while the session’s run is queued or running and answers
the moment it settles — or immediately when no run is active. `timeout`
bounds the park in milliseconds (0–300000, default 30000; `0` answers
with a single snapshot, no park):

``` bash
curl -sS -H "Authorization: Bearer glv_at_…" \
  "http://localhost:3457/api/sessions/goose:abc123/wait?timeout=30000"
```

A resolved wait answers `200` with the terminal status and the same
`last_run` verdict the session rows carry — so one call says both “done”
and “how it ended” (a clean finish vs a stop by request vs a provider
refusal vs a crash; the `last_run.state` table below spells the states):

``` json
{"id":"goose:abc123","status":"completed",
 "last_run":{"state":"finished","ended_at":"2026-10-23T00:41:02.000Z"}}
```

`idle` answers a session with no registered run — one that never ran, or
whose settled run already left the registry window — and still carries
the last recorded verdict, so a wait that arrives late can never mistake
“went idle” for “finished cleanly”.

When the deadline passes with the run still active, the answer is `202`
with the live status (`{"id":"goose:abc123","status":"running"}`) — call
again to keep waiting, which covers runs longer than any single
deadline. That loop replaces the status poll above entirely:

``` bash
while :; do
  s=$(curl -sS -H "Authorization: Bearer glv_at_…" \
    "http://localhost:3457/api/sessions/goose:abc123/wait?timeout=30000" \
    | jq -r .status)
  case "$s" in running | queued) ;; *) break ;; esac
done
```

#### Polling without re-downloading the transcript

The detail endpoint returns the whole transcript by default, so a poll
loop pays full-transcript cost on every tick — and the runs that most
need polling are the long ones. Two query windows keep the cost flat:

- `?fields=meta` answers with the `session` object and **no `messages`
  key** — the cheap poll above, which wants only the status.
- `?after=<message-index>` answers with the `session` object and only
  the messages **from** that transcript index on (0-based, oldest first
  — the index is the count of messages you already hold). Empty once
  caught up.

An incremental poll keeps a cursor — the count of messages it holds —
and advances it by the length of each answer:

``` bash
cursor=0
while :; do
  body=$(curl -sS -H "Authorization: Bearer glv_at_…" \
    "http://localhost:3457/api/sessions/goose:abc123?after=$cursor")
  cursor=$((cursor + $(printf %s "$body" | jq '.messages | length')))
  case $(printf %s "$body" | jq -r .session.status) in
    running | queued) sleep 2 ;;
    *) break ;;
  esac
done
```

An `after` at or past the transcript’s end answers `messages: []` — the
cursor never goes stale. Invalid values (`?after=-1`, `?after=abc`,
`?fields=anything-else`, or both parameters at once) are rejected with
`422`.

`status` alone cannot say *how* the last run ended once the registry
window closes — and while it is open, a provider’s usage-limit refusal
and a clean finish can both leave the session inactive with exit code 0
on the agent’s side. So the same rows also carry `last_run`, the
persisted verdict of the most recent settled run, recorded in the
stop-notices sidecar the moment the run settles and surviving a server
restart:

| `last_run.state` | Meaning |
|----|----|
| `finished` | the run settled normally |
| `stopped` | the run was stopped by request |
| `stopped_early` | the provider refused service (a usage limit with its reset time, a network outage) |
| `failed` | the run crashed (non-zero exit, signal death, startup-watchdog kill) |

`last_run` is omitted until the session has settled a run;
`last_run.reason` appears only for `stopped_early` and `failed` and
carries the same wording the viewer shows (the provider’s own words —
reset time included — or the crash verdict with its stderr tail);
`last_run.ended_at` is the settle instant (ISO UTC). Checking it after
the wait loop above is how an orchestration loop tells a merged-PR
success from a silently stopped run:

``` bash
curl -sS -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/api/sessions/goose:abc123 \
  | jq -c .session.last_run
# {"state":"stopped_early","reason":"Session stopped early: provider
#  usage limit reached. … resets at 17:01. …","ended_at":"2026-10-22T21:04:11.512Z"}
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
`422 {"error":"…"}`; unknown ids `404`. A pinned `model` is checked
against the agent’s live model catalogue — the same list the picker
shows, and the one `GET /api/models` (below) returns — so a typo answers
`422` instead of starting a run that dies at agent startup. The check
reads a short-lived cache the picker keeps warm; a pinned submit with
the cache cold (typical for scripts and CI) pays a one-off catalogue
fetch first, usually a second or two.

#### Discovering and validating model pins

`GET /api/models` returns the catalogue the New Session picker renders
from — one entry per served agent, every model it offers with its
provider, id, and label, plus the agent’s own default selection. Each
model carries a `pin`: the exact `agent:provider:model` spelling the
`model` field of `POST /api/sessions` (and the scheduled-run forms)
accepts. Discover a pin here, submit it there, and it validates — no
screen-scraping or reimplementing the agent’s catalogue protocol:

``` bash
curl -sS -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/api/models
```

``` json
{
  "agents": [
    {
      "agent": "goose",
      "label": "goose",
      "default": { "provider": "zai", "model": "glm-5.3" },
      "models": [
        {
          "provider": "zai",
          "model": "glm-5.3",
          "label": "GLM-5.3",
          "pin": "goose:zai:glm-5.3"
        },
        {
          "provider": "zai",
          "model": "glm-5.1",
          "label": "GLM-5.1",
          "pin": "goose:zai:glm-5.1"
        }
      ]
    }
  ]
}
```

`default` is omitted when the agent has no readable default of its own.
Resolving a catalogue may spawn the agent binary (goose answers over
ACP), so the first call after boot — or after the short-lived cache
lapses — can take a second or two; the endpoint shares the picker’s
cache, so a call also warms it for submit-time pin validation.

`GET /api/openapi.json` serves the machine-readable contract — generated
from the same schemas the routes validate with, so it cannot drift —
behind the same auth as every other `/api` path. Destructive operations
(archive, delete) and every management surface (tokens, groups) stay in
the browser; the saved-prompt library is written and read over JSON
(below).

### Managing saved prompts over the API

The prompt library is scriptable both ways — the same rows the browser
library renders, written and read through the same operation layer the
browser’s save and edit forms use, so both surfaces run identical
effects. Reads need only the cookie; writes take the bearer only:

| Endpoint               | Effect                                        |
|------------------------|-----------------------------------------------|
| `GET /api/prompts`     | list saved prompts (manual order)             |
| `GET /api/prompts/:id` | read one prompt, body included                |
| `POST /api/prompts`    | save a prompt (multipart form, bearer only)   |
| `PUT /api/prompts/:id` | update a prompt (multipart form, bearer only) |

``` bash
# seed or repair a library entry from a script
PROMPT_ID=$(curl -sS -X POST http://localhost:3457/api/prompts \
  -H "Authorization: Bearer glv_at_…" \
  -F title="Refactor sweep" \
  -F body="Tidy {{repo}} on branch {{branch}} and summarize." \
  -F category="Code care" | jq -r .id)

# edit it later — a full save; every submit rewrites the three fields
curl -sS -X PUT "http://localhost:3457/api/prompts/$PROMPT_ID" \
  -H "Authorization: Bearer glv_at_…" \
  -F title="Refactor sweep (strict)" \
  -F body="Tidy {{repo}} and summarize, failing on any leftover TODO."
```

The create answers `201` with a `Location` header and the stored prompt;
the update answers `200` with the row as stored — id, sort position, and
usage stats untouched. Both take the fields the browser forms accept:
`title` and `body` required (blank answers `422 {"error":"…"}`),
`category` optional (blank stores `null`, clearing it). Unknown ids
answer `404`. Deleting a prompt and reordering the library stay in the
browser — a destructive op and a UI concern, respectively.

``` bash
curl -sS -H "Authorization: Bearer glv_at_…" \
  http://localhost:3457/api/prompts
```

Each row carries the prompt `body` verbatim — placeholders like
`{{working_dir}}` included, unsubstituted (the browser fills those at
run time) — plus `category`, `usage_count`, and the timestamps (ISO 8601
UTC with an explicit `Z`, like every other timestamp the API returns).
Rows with no category spell it `null`, and a prompt that has never been
run carries `last_used_at: null`.

### Scheduling runs over the API

Scheduled runs are scriptable too — the same schedule grammar the
browser form accepts (a one-shot ISO datetime, a cron pattern, or
English text), written through the same operation layer, landing in the
same cron database and picked up by the running scheduler immediately:

| Endpoint                   | Effect                                       |
|----------------------------|----------------------------------------------|
| `GET /api/cron`            | list scheduled runs (creation order)         |
| `GET /api/cron/:name`      | read one run                                 |
| `POST /api/cron`           | schedule a run (multipart form, bearer only) |
| `POST /api/cron/:name/run` | fire a run now (answers 202 once started)    |
| `DELETE /api/cron/:name`   | cancel a run                                 |

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
spelling — and same live-catalogue validation — as the session API), and
repeated `follow_ups` parts chaining further prompts after the first (10
steps in total, at most). Every row carries `next_runs` — the next fire
times — while it is enabled. Cancel anything that has not fired yet:

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
headless Chromium), so testing happens in CI on every pull request,
including the first: as soon as build and lint pass, push and open the
PR — a draft if the work is not ready for review — and watch the checks
instead of running the suite locally first. CI runs the suite in four
shards on Ubuntu on every push (`.github/workflows/ci.yml`; prose-only
changes skip it via `paths-ignore`). Run the suite locally only to
reproduce a failure CI reported.

Every test file boots a real `glv serve` process plus a headless
Chromium, so the suite runs at most two files at a time to keep peak
memory in check on local machines (CI, with dedicated vCPUs, runs four
at once per shard).

`pnpm test` collects coverage across those spawned processes, not just
the in-process test files: each launcher is pointed at Node’s built-in
V8 profiler (`NODE_V8_COVERAGE`) and type-a-bin’s subprocess-coverage
provider, wired up in `vitest.config.ts`, merges those raw profiles (and
the recorded tsx transforms) into the vitest report, so it includes the
server, runner, and view code the suite actually drives. Coverage floors
live in `vitest.config.ts`. A bare `vitest run --coverage` reports only
in-process code. Serve-process coverage requires a graceful exit to
flush profiles; Node’s `kill()` on Windows terminates unconditionally,
so there it is limited to CLI invocations (which exit normally) and the
coverage-propagation suites are excluded on `win32` — see the exclusion
list in `vitest.config.ts`. (Windows is out of CI today, so that
exclusion matters only for local Windows runs.)

Product code lives once, in `src/glv/` — the views, client scripts,
server, runner, stylesheet, and the test harness — while the two flavor
trees (`src/goose/`, `src/claude/`) hold only the adapters that
genuinely differ: agent invocation, the storage adapter, the new-session
launch strategy, model catalogues, and profile metadata. `pnpm lint`
enforces that one-location rule (no mirrored files, no cross-tree code
clones). The stylesheet ([Tailwind CSS v4](https://tailwindcss.com),
`src/glv/styles/app.css`, CSS-first setup with a `@theme` block of
design tokens) and the client scripts (`src/glv/scripts/*.ts`) are
compiled by `pnpm build:assets` into `dist/<flavor>/` — one shared
build, emitted once per flavor so the `glv`, `goose`, and `claude` entry
points all serve current assets. The product itself — one server, one
sidebar, one schedule serving both agents — is launched with `glv`.

UI-facing changes ship before-and-after screenshots in the PR
description: `pnpm shots` builds the assets, boots a real server against
the mock agent, drives the UI with Playwright, and writes the PNGs to
`pr-shots/` (gitignored).

## The CLI

Everything above is driven by the `glv` command, which also offers a few
lightweight terminal commands for quick lookups without opening a
browser:

``` bash
glv sessions      # list recent sessions (ids namespaced per agent)
glv view <id>     # show prompts + outputs for a session
glv logs          # list goose --no-session runs
```

## Contributing

Bug reports, feature ideas, and pull requests are welcome —
[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and what a good PR looks
like, and the enforced coding conventions live in
[AGENTS.md](AGENTS.md). Security issues follow
[SECURITY.md](SECURITY.md): report them privately, not as a public
issue. Participation is governed by the [Code of
Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE).
