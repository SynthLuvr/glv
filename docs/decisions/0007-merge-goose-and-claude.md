# ADR 0007: Merge glv-goose and glv-claude into one product

- Status: Accepted
- Date: 2026-09-25
- Deciders: glv maintainers

## Context

ADR 0002 merged the *code*: `src/glv/` now holds the whole shared
product — views, client scripts, server, runner, styles, format layer,
git/PR support, and the shared test suites — while `src/goose/` and
`src/claude/` shrank to thin adapters (a profile, a store, a launcher,
an agent argv builder, a CLI, and flavor-specific fixtures). Measured
today: roughly 19K lines of shared product code in `src/glv/`, against
about 1K lines of adapters per flavor tree.

The *product*, however, is still two things. `package.json` ships two
binaries, each a separate process with a separate identity:

- `glv-goose serve` reads goose’s sessions DB, writes viewer metadata
  into that DB, and keeps everything glv-owned under
  `~/.local/share/glv-goose`.
- `glv-claude serve` reads claude’s JSONL transcripts, keeps viewer
  metadata in its own meta sidecar, and keeps everything glv-owned under
  `~/.local/share/glv-claude`.

Because every glv-owned artifact is namespaced by the flavor’s data
directory name (the `dataDirName` field of `FlavorProfile`, consumed
through `resolveDataPath` in `src/glv/db-path.ts`), the two products
share nothing at runtime: two passkey databases (two enrollments, two
logins), two prompt libraries, two group sets, two cron stores, two
upload and temp areas, two servers on two ports, two sidebars in two
browser tabs. `scripts/setup.mjs` installs only the `glv-goose` shim, so
a claude user has a second, manual install path.

The seam ADR 0002 created — one `SessionStore`, one `SessionLauncher`,
one `Runner`, one optional `ModelSource`, and one `FlavorProfile` per
`ServerContext` (`src/glv/server/context.ts`) — is exactly what makes a
real merge cheap now, but it also hard-codes “one agent per server
process” in every route.

## Decision

Merge the two viewers into **one product**: a single `glv` binary and
server process that can serve goose, claude, or both at once, behind one
login, one sidebar, and one schedule.

- `glv serve` loads **both** agents, with per-agent degradation: an
  agent whose binary or data directory is missing is hidden, not fatal.
  There is no agent-choice option — the both-agents default is the only
  behavior. The `glv-goose` and `glv-claude` binaries retire with the
  cutover: with no agent choice to preserve, a shim would just duplicate
  `glv`.
- Session ids become **namespaced at the composite boundary** —
  `goose:<id>` and `claude:<id>` — and stay opaque to every route, SSE
  event, and client script. Per-flavor stores keep their native ids; the
  composite store splits on the prefix and dispatches.
- glv-owned data unifies under one directory (`~/.local/share/glv`): one
  auth database (one passkey), one prompt library, one group set, one
  cron database, one uploads/temp root. A one-time migration copies and
  re-keys rows from the legacy per-flavor directories.
- The New Session form has **one combined model picker** instead of an
  agent picker: every served agent declares a `ModelSource` (claude’s is
  its alias list), and each contributes its default entry and models to
  one select — the pick names both the agent and the model. Sidebar rows
  and transcript headers gain an agent chip.
- Cron jobs gain an `agent` column; a job fires through the launcher of
  its agent, and the existing “model pins only where the agent supports
  them” validation generalizes from “claude” to “any agent without a
  model source”.
- Per ADR 0002’s rules, the flavor directories survive as adapters. The
  merge composes adapters; it does not push `if flavor === ...` branches
  into the core.

## Design

### Namespaced session ids

Every place a session id crosses the composite boundary is prefixed:
URLs (`/sessions/goose%3A<id>/...`), SSE payloads, group membership,
cron session tags, upload directory tags. The routing and rendering
layers already treat ids as opaque strings, so the change is
concentrated in:

- a `CompositeSessionStore` implementing `SessionStore` over two child
  stores (list = merge both, sort by `updated_at`, cap at the filter
  limit; mutations = dispatch by prefix),
- a `CompositeLauncher` dispatching `startNew`/`awaitNew`/`establish` to
  the child launcher named by the handle’s agent, and
- a one-time migration rewriting persisted ids in the legacy
  `groups.db`, `cron.db`, and uploads tags with their flavor prefix
  (which legacy directory a row came from determines the prefix).

goose and claude both mint uuid-shaped ids from different stores, so a
raw collision is improbable but nothing prevents it; the prefix removes
the doubt and makes every persisted row self-describing.

### Server context

`ServerContext`’s single-agent fields become a registry:
`agents: Record<FlavorId, AgentRuntime>` where `AgentRuntime` bundles
the profile, store, launcher, and optional model source. Routes that are
per-session (`stream`, transcript, rename, archive, delete) resolve the
agent from the id prefix; routes that are per-request (new session, cron
forms) resolve it from the submitted agent. The runner stays a single
shared queue — one concurrency pool (default 6) across both agents,
matching today’s “six concurrent runs” semantics; per-agent caps are
deferred until someone needs them.

### CLI

One commander program: `glv serve`, `glv sessions`, `glv view <id>`, and
goose’s `logs` (available when goose’s store is readable).
Flavor-specific serve flags keep their names (`--goose-binary`,
`--claude-binary`, `--permission-mode`) and apply to their agent. The
two legacy binaries are deleted; `glv` is the only program.

### Migration

First `glv serve` start against an empty `glv` data directory:

1.  Adopt `glv-goose/prompts.db`, `groups.db`, `cron.db` rows, then
    merge `glv-claude`’s (re-keying ids as above; row conflicts resolve
    in favor of goose, matching the config-file migration precedent).
2.  Auth: adopt a legacy auth database wholesale when exactly one of the
    two has an owner — the common single-flavor user keeps their passkey
    with zero action. When both have owners, adopt goose’s and log a
    notice that the claude credential was retired (re-enroll via
    `/auth/devices`); merging two independent WebAuthn credential sets
    under one single-occupancy user is not worth the ambiguity.
3.  Legacy directories are left in place (renamed `.migrated`), never
    deleted, by the migration.

### Testing

The shared suites already run against either flavor through the
`FlavorFixture` harness. A third fixture mode, `combined`, boots one
serve process with both mock agents and runs the identity-sensitive
suites (sidebar, stream, groups, cron, session-delete) against the
composite store. Per-flavor suites keep their single-agent bindings; the
platform exclusions carry over unchanged.

## Rationale

- The user-visible cost of the split is paid daily: two logins for one
  machine’s work, two tabs, schedules split across two databases, and no
  way to see “what did all my agents do today” in one place.
- Operationally, one process replaces two (one systemd unit, one port,
  one log stream), and setup installs one command.
- The codebase is ready: ADR 0002 already located every genuine
  difference behind an interface, and the composite layer is a consumer
  of those interfaces, not a new fork of them. The estimated core change
  is the registry threading (~10 files consume `ctx.profile` today), the
  composite store/launcher, the CLI unification, and the migration.
- It completes the trajectory the repo is already on: adding a third
  agent becomes profile + store + launcher + argv builder + fixture —
  with instant visibility in the same UI.

## Alternatives considered

- **Status quo.** Zero migration risk, but every user-facing and
  operational cost above stays forever, and the two products drift in
  lockstep only through discipline.
- **Code-only merge (shared CLI factory, still two binaries).** Cheap
  (collapses the last ~170-line structural twin in the two `cli.ts`) but
  changes nothing a user can feel; subsumed by this proposal’s stage 0.
- **Front the two servers with a reverse proxy.** Two auth realms and
  two UIs remain; a proxy cannot merge a sidebar or a cron store.
- **Protocol-level unification (ACP for both agents).** A far larger
  lift that would trade per-agent fidelity (claude transcript shapes,
  permission modes; goose’s ACP catalogue is explicitly unstable) for an
  abstraction neither agent fully honors. Revisited only if a third
  ACP-native agent arrives.

## Staged rollout

Each stage is independently shippable; per repo rules, each lands as a
PR that CI tests, and UI changes carry screenshots.

1.  **Stage 0 — CLI factory.** Collapse the twin `cli.ts` files into a
    shared factory parameterized by profile and per-flavor command
    registrations. No behavior change; builds the muscle for stage 3.
2.  **Stage 1 — composite core.** Add `CompositeSessionStore`,
    `CompositeLauncher`, and id namespacing behind the existing
    interfaces, plus the `combined` test fixture. Single-agent serve
    behavior is unchanged (a composite of one is the identity).
3.  **Stage 2 — merged serve.** `glv serve` with both agents loaded by
    default, the registry in `ServerContext`, the combined model picker
    and chips, unified data directory with migration, cron `agent`
    column. This is the user-facing PR.
4.  **Stage 3 — cutover.** One `glv` binary; `glv-goose`/`glv-claude`
    retire (no shims: with both agents the default, a per-flavor entry
    point has nothing to select); setup and README follow.

## Consequences

- One login, one sidebar, one schedule across agents; one process to run
  and update.
- The id namespacing touches every identity-bearing path; the
  arktype-typed SSE contract suite and the `combined` fixture are the
  guardrails, and the migration is the riskiest single piece (it is
  idempotent, keeps legacy directories, and runs once).
- Two agents share one process and one concurrency pool; a slow agent
  spawn cannot starve the other beyond the pool bound, which is the same
  bound single-agent users accept today.
- Two small honest losses: the `--db`/`--projects-dir` global options
  become per-agent (`--goose-db`, `--projects-dir` stays claude’s), and
  users with both legacy auth databases enroll once more.
- `FlavorProfile.dataDirName` survives as the legacy-directory name the
  migration reads and as the suffix of per-agent environment overrides;
  new glv-owned defaults collapse into the shared `glv` directory.
