# ADR 0002: Consolidate the product into one glv core with thin flavor adapters

- Status: Accepted
- Date: 2026-08-17
- Deciders: glv maintainers

## Context

`glv-goose` and `glv-claude` are two viewers for two agents, but they
are the same product: a self-hosted web UI that browses agent sessions,
streams live runs, and launches new ones. Until now they lived as two
parallel trees, `src/goose/` and `src/claude/`, copied wholesale when
the claude viewer was created:

- about 5,400 lines of non-test code were byte-for-byte identical,
- another ~4,000 lines differed only by the flavor name, and
- the ~5,300 lines of tests were 94-99% identical.

Every fix, feature, and style change had to be made twice, and the
duplication linter could not see the drift because it checked each tree
separately. Both CLIs stay separate products with separate binaries and
identities; nothing user-facing was allowed to change.

## Decision

Consolidate into one core with two thin flavors:

- `src/glv/` holds everything both viewers use: views, client scripts,
  the server (app factory and routes), the session runner, styles, the
  format layer, git/PR support, and the shared test harness with its
  scenario suites.
- The flavor directories shrink to adapters: each keeps `cli.ts`
  (options parsing), `db.ts` (a `SessionStore` implementation),
  `agent.ts` (an `AgentInvocation` argv builder), `launch.ts` (a
  `SessionLauncher` strategy), `profile.ts` (flavor facts as data), and
  a 3-line `build.ts` wrapper. `src/claude/` additionally keeps its
  transcript readers under `store/`.

Three rules governed the migration:

1.  Identical code lives once, in `src/glv/`.
2.  Differences are data or adapters. A difference that is a name, path,
    or flag becomes a field on `FlavorProfile`; a difference in real
    behavior becomes a shared interface with one implementation per
    flavor (`SessionStore`, `SessionLauncher`, `AgentInvocation`).
3.  No flavor branches in the core. Shared code with `if flavor === ...`
    checks is duplication in disguise.

Guardrails make drift impossible to reintroduce: `lint:mirrored` fails
on any file with identical content in two trees, and `lint:cross-tree`
runs jscpd across all of `src/` so any clone pair spanning trees fails
the build. Transitional exemption lists tracked the migration debt and
were deleted once empty.

## Rationale

- The adapter seams match the real differences. goose stores sessions in
  SQLite and discovers new session ids after the run starts; claude
  writes JSONL transcripts and pre-assigns ids. The `SessionStore` and
  `SessionLauncher` interfaces let each flavor keep its behavior while
  the routes, runner, and UI become single-copy.
- Profiles keep name-only differences out of branches. Binary names,
  data directories, stream dialects, and branding strings are data on
  `FlavorProfile`, threaded through `ServerContext`.
- The test harness parameterizes by a `FlavorFixture` (seeding, mock
  agent, native content-block shapes), so a scenario is written once and
  runs against both flavors over real localhost HTTP with real serve
  processes, preserving the testing rules in AGENTS.md.

## Consequences

- A bug fix or feature lands once, in `src/glv/`.
- Adding a third agent viewer is a small, well-scoped task: a profile, a
  store adapter, a launcher, an agent builder, a CLI, and fixture
  seeding.
- Flavor directories are reviewable at a glance: everything in them is a
  genuine difference.
- The per-tree jscpd thresholds temporarily raised during the migration
  (shrinking trees concentrated the still-mirrored test duplication) are
  restored to 5%; with suites shared, all three trees pass.
- Costs accepted: one more directory level for core imports
  (`../../glv/...`), and fixture indirection in tests in exchange for
  single-copy scenarios.
