# AGENTS.md

Instructions for AI coding agents working in this repository.

## Quick Start

``` bash
pnpm install
pnpm build    # type-check
pnpm test     # run tests
pnpm lint     # lint all files
```

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
**forbidden** — do not add them. If you add an endpoint, a UI flow, or
a data change,
add a test in `src/tests/` (filenames end in `.integration.test.ts`)
that would fail without your change.

### No function mocks

Do **not** mock functions, modules, or methods (`vi.fn`, `jest.fn`,
monkey-patching, stubbing internals, etc.). Tests must run against the
real implementation. The only "mock" allowed is substituting an
external process binary (e.g. the `goose` CLI) with a real script on
`PATH` — never a function-level mock.

### Test over localhost HTTP only

All assertions must be made by querying the running server over
`http://localhost:<port>`. Use the helpers in
`src/tests/integration-harness.ts` (`startIntegrationEnv`,
`authedFetch`, `collectSse`, `withPage`) to boot a real `glv serve`
process on a free localhost port and hit its endpoints over HTTP/SSE.
Do not import server internals into a test or call handlers directly.

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

- Source code lives in `src/`
- Tests live in `src/tests/` (filenames end in `.test.ts`)
- TypeScript is type-check only (`noEmit: true`) — use `tsx` for dev
  execution
- ESM only (`"type": "module"`)
