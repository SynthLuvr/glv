# AGENTS.md

Instructions for AI coding agents working in this repository.

## Quick Start

``` bash
pnpm install
pnpm build    # type-check
pnpm test     # run tests (local before a PR opens, CI once open)
pnpm lint     # lint all files
```

## Required Workflow

Split each check by where it runs — build and lint are always local;
testing moves to CI once a pull request is open:

### Build and lint: always local, before every push

``` bash
pnpm build && pnpm lint
```

Both must pass with zero errors. They are fast, so run them before every
push — never push code that would fail either.

### Testing: local before a PR exists, CI while it is open

The test suite is slow (every test file boots a real server plus a
headless Chromium) and CI re-runs it in shards on every push to an open
pull request. Do not duplicate that work:

- **Before opening a PR:** run `pnpm test` locally once and make it pass
  (zero failures, coverage floors intact). Only then open the PR.
- **While a PR is open:** testing happens in CI
  (`.github/workflows/ci.yml` triggers on `pull_request`). After the
  local build and lint pass, push and watch the PR checks instead of
  re-running the full suite locally — re-run it locally only to
  reproduce a failure CI reported.
- **No PR open** (early exploration, or work heading straight to
  `main`): testing is local — run `pnpm test` when you need test
  validation.

This split exists to avoid the wasteful loop of running the suite
locally, pushing, then waiting for CI to run the identical suite again.

## Testing Requirements (Enforced)

### New features need integration tests

Every new feature or behavior change **must** ship with an integration
test that exercises the real code path end-to-end. Pure unit tests are
**forbidden**. If you add an endpoint, a UI flow, or a data change, add
a test in `src/goose/tests/` or `src/claude/tests/` (filenames end in
`.integration.test.ts`) that would fail without your change.

### No function mocks

Do **not** mock functions, modules, or methods (`vi.fn`, `jest.fn`,
monkey-patching, stubbing internals, etc.). Tests must run against the
real implementation. The only exception is replacing an external process
binary (e.g. the `goose` CLI) with a real script on `PATH`.

### Test over localhost HTTP only

All assertions must be made by querying the running server over
`http://localhost:<port>`. Use the helpers in
`src/goose/tests/integration-harness.ts` or
`src/claude/tests/integration-harness.ts` (`startIntegrationEnv`,
`authedFetch`, `collectSse`, `withPage`) to boot a real
`glv-goose serve` or `glv-claude serve` process on a free localhost port
and hit its endpoints over HTTP/SSE. Do not import server internals into
a test or call handlers directly.

### Coverage

`pnpm test` runs through `scripts/vitest-coverage.mts`, which enables
subprocess coverage: spawned servers/CLIs write raw V8 profiles, and the
recorded tsx transforms get merged into the vitest report (see
type-a-bin’s `subprocess-coverage` companion). Thresholds in
`vitest.config.ts` fail the run if coverage drops below the floors —
when adding product code, either cover it with a new integration test or
expect the floors to catch the drop.

## Screenshots on UI PRs (enforced)

Every PR that changes anything a user can see — views, styles, client
scripts, generated markup — ships screenshots **in its description**:
before and after when reworking existing UI, one shot of the new surface
when introducing UI. A UI PR without screenshots is incomplete;
reviewers must not have to check the branch out to see what changed.

- **Never commit image assets to the repo** — no screenshots, PNGs,
  JPGs, GIFs, or video in the tree, in any PR. They live in the PR
  description only.
- **Upload to GitHub and embed the user-attachment URL** —
  `https://github.com/user-attachments/assets/<uuid>`, exactly what
  drag-and-drop into the description produces. Do **not** link release
  assets or external hosts: this repo is private, and release-asset URLs
  return 404 to anonymous fetchers (GitHub’s image proxy included), so
  they render as broken images in the description.

Uploading needs no browser — the single-request endpoint works with any
token that can push to the repo (`gh auth token` supplies one):

``` bash
REPO_ID=$(gh api repos/SynthLuvr/glv --jq .id)
URL="https://uploads.github.com/user-attachments/assets"
URL="$URL?name=shot.png&content_type=image%2Fpng&repository_id=$REPO_ID"
curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $(gh auth token)" \
  -H "Accept: application/json" \
  -H "Content-Type: image/png" \
  --data-binary @shot.png
# 201 → {"url":"https://github.com/user-attachments/assets/<uuid>"}
# embed that URL in the PR description
```

URL-encode `name` and `content_type`, and send the file’s bytes as the
body with a matching `Content-Type` header. The `github.com` upload
endpoints (`/user-attachments`, `/upload/policies/assets`) are
browser-only and answer 422 to tokens — use the `uploads.github.com`
route above.

## Coding Conventions (Enforced)

These are **not** preferences — the toolchain will fail if you violate
them:

### No function declarations

Use `const` + arrow function instead.

``` ts
// ❌ Wrong
function foo() {}

// ✅ Right
const foo = (): void => {};
```

**Exception: function overloads.** TypeScript overloads *require*
`function` declarations — each signature reuses the same name, which is
impossible with `const`. Overload sets are permitted, and the
`no-function-declaration` rule skips any `function_declaration` that
immediately follows an overload signature:

``` ts
// ✅ Allowed — overloads must use function declarations
function toLabel(value: string): string;
function toLabel(value: number): string;
function toLabel(value: string | number): string {
  return `label: ${value}`;
}
```

### No inline exports

Write `export` as a separate statement.

``` ts
// ❌ Wrong
export const foo = 1;

// ✅ Right
const foo = 1;
export { foo };
```

### Single-statement braces are stripped

`if`/`for`/`while` with a single body statement should not have braces.

``` ts
// ❌ Wrong
if (done)
  return;
}

// ✅ Right
if (done)
  return;
```

### Formatting

- Double quotes
- 2-space indentation
- 80-character line width
- Trailing commas
- Semicolons
- Arrow function parentheses always

## Formatting

If the linter complains about formatting, run:

``` bash
pnpm format
```

This runs `ts-canon format`: five steps in order — 1. `convert-to-arrow`
(rewrites `function` declarations to arrow consts) 2. `strip-braces`
(removes unnecessary braces from single-statement blocks) 3.
`biome format` 4. `biome check` (applies lint auto-fixes) 5. pandoc
(canonicalizes Markdown). Since ts-canon 0.1.4 every ast-grep rule ships
a TypeScript and a Tsx document under the same id, so both the lint
rules and the codemods cover `.ts` and `.tsx` files alike.

## Toolchain

The lint/format toolchain comes from
[`ts-canon`](https://github.com/SynthLuvr/ts-canon), shared with
`typescript-template` and the org’s other TypeScript repos: it bundles
biome, oxlint (+ tsgolint), ast-grep, jscpd, and the codemods, and ships
the canonical `biome.json`, `tsconfig`, and vitest presets this repo
extends (`sgconfig.yml` points bare `ast-grep scan` and editor
integrations at its rules). The repo-specific checks remain local:
`lint:mirrored` and `lint:cross-tree` (see below).

## Project Structure

- Shared product code lives in `src/glv/` — the glv core: views, client
  scripts, server, runner, styles, format, git/PR support, and the test
  harness with shared scenario suites
- Each flavor directory holds only what genuinely differs: `src/goose/`
  and `src/claude/` contain `cli.ts`, `db.ts` (storage adapter),
  `agent.ts` (invocation builder), `launch.ts` (new-session strategy),
  `profile.ts`, and a 3-line `build.ts` wrapper; `src/claude/` also
  keeps its `store/` transcript readers
- Integration tests live in `src/goose/tests/` and `src/claude/tests/`:
  thin wrappers binding shared suites from `src/glv/tests/suites/` to
  the flavor fixture, plus genuinely flavor-specific tests (filenames
  end in `.integration.test.ts`)
- TypeScript is type-check only (`noEmit: true`) — use `tsx` for dev
  execution
- ESM only (`"type": "module"`)

## One-location rule (enforced)

A source file may live in `src/goose/`, `src/claude/`, or `src/glv/` —
never in more than one of them. `pnpm lint` fails on either:

- a path existing in two trees with identical content (`lint:mirrored`),
  or
- a code clone spanning two trees (`lint:cross-tree`, jscpd across all
  of `src/`; enforced floor ≥3 lines and ≥50 tokens — byte-identical
  copies of any size fail `lint:mirrored`).

Same-path files with genuinely different content (the flavor adapters,
profiles, and CLIs) are the intended end state and are not mirrors; any
code fragment shared between them belongs once in `src/glv/`, and the
cross-tree clone check enforces that. The transitional exemption lists
that tracked the consolidation were deleted when they emptied; the rule
is absolute.
