# AGENTS.md

Instructions for AI coding agents working in this repository.

## Quick Start

``` bash
pnpm install
pnpm build    # type-check
pnpm test     # run tests
pnpm lint     # lint all files
```

## Windows shell hazard: one command, one line (enforced by convention)

On Windows, shell commands run through `cmd /c`, which **silently drops
everything after the first newline** — including newlines inside quoted
arguments. Exit code stays 0 and nothing errors, so a multi-line
`gh pr create --body "…"`, `git commit -m "…"`, or pasted script quietly
loses all lines after the first (this truncated a PR body and a commit
message to their first lines before being caught). Verified behavior:

``` text
cmd /c "echo LINE_A\n(echo LINE_B)"   → prints LINE_A only
powershell -Command "<multi-line>"    → runs every line
```

Therefore:

- Keep every shell command on a single line; chain steps with `&&`.
- Multi-line content (PR bodies, commit messages) goes through files:
  write the content to a file, then `gh pr create|edit --body-file
  <file>` and `git commit -F <file>`.
- Multi-line scripts are written to a file and executed as a file —
  never pasted into the command string.
- Setting `GOOSE_SHELL` to `powershell`/`pwsh` avoids the quirk, but do
  not assume it is set.

## Required Workflow

Always run these before considering work complete:

``` bash
pnpm build && pnpm lint && pnpm test
```

All three must pass with zero errors.

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

This runs four steps in order: 1. `convert-to-arrow` — rewrites
`function` declarations to arrow consts 2. `strip-braces` — removes
unnecessary braces from single-statement blocks 3. `biome format` —
formats all files 4. `biome check` — applies lint auto-fixes

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
