# TypeScript Template — Developer Guide

> **TL;DR:** Minimal TypeScript project template with a complete build,
> format, lint, and test toolchain. The code does nothing useful — it’s
> a starting point for new projects.

## 1. Project Overview

A boilerplate repository that wires up a full, opinionated TypeScript
toolchain so you can start writing code immediately without configuring
anything.

- **Type checking** — `tsc` in strict mode (no emit)
- **Formatting** — Biome + ast-grep codemods
- **Linting** — Biome + oxlint + ast-grep structural rules
- **Testing** — Vitest
- **CI** — GitHub Actions (build → lint → test on every PR)

The template code is intentionally trivial: a single `greet()` function
and one test.

## 2. Tech Stack

| Category                 | Technology       | Notes                                                               |
|--------------------------|------------------|---------------------------------------------------------------------|
| **Runtime**              | Node.js 24       | Required (`engines` field in `package.json`)                        |
| **Package Manager**      | pnpm 11.8.0      | Enforced via `packageManager` field                                 |
| **Language**             | TypeScript 6     | Strict mode, ES2025 target, ES modules                              |
| **Execution**            | tsx              | Runs `.ts` files directly without a build step                      |
| **Testing**              | Vitest 4         | Test runner with config in `vitest.config.ts`                       |
| **Formatting**           | Biome 2.5        | Primary formatter + linter                                          |
| **Linting**              | oxlint 1.71      | Type-aware secondary linter                                         |
| **Structural Rules**     | ast-grep 0.43    | Enforces no-function-declaration, no-inline-export, brace stripping |
| **Code Tools**           | convert-to-arrow | Automated `function → arrow const` codemod                          |
| **Script Orchestration** | npm-run-all2     | Runs multi-step format/lint pipelines                               |
| **CI**                   | GitHub Actions   | build → lint → test on PRs                                          |

## 3. Prerequisites & Setup

### Installation

``` bash
pnpm install
```

### Run Scripts

``` bash
pnpm build    # type-check with tsc
pnpm test     # run unit tests
pnpm lint     # run all linters
pnpm format   # run all formatters (auto-fix)
```

### Required Workflow

Before considering work complete, always run:

``` bash
pnpm build && pnpm lint && pnpm test
```

All three must pass with zero errors.

## 4. Project Structure

    typescript-template/
    ├── .ast-grep/
    │   └── rules/
    │       ├── no-function-declaration.yml   # enforce arrow functions
    │       ├── no-inline-export.yml          # enforce separate export statements
    │       └── strip-braces.yml              # strip single-statement braces
    ├── .github/
    │   └── workflows/
    │       ├── ci.yml                        # build → lint → test on PR
    │       └── copilot-setup-steps.yml       # Copilot agent environment
    ├── src/
    │   ├── index.ts                          # Trivial module (replace with your code)
    │   └── tests/
    │       └── index.test.ts                 # Trivial test
    ├── .gitignore                            # node_modules, dist, *.js
    ├── .oxlintrc.json                        # Type-aware oxlint rules
    ├── AGENTS.md                             # Instructions for AI agents
    ├── README.md                             # User-facing docs
    ├── DEVELOPER_GUIDE.md                    # This file
    ├── biome.json                            # Biome formatter + linter config
    ├── package.json                          # Dependencies, scripts, engine constraints
    ├── pnpm-workspace.yaml                   # Build allowlist for native packages
    ├── tsconfig.json                         # TypeScript config (strict, ES2025, noEmit)
    └── vitest.config.ts                      # Vitest config

## 5. Coding Conventions

These are **enforced by the toolchain**, not preferences. The linter
will fail if you violate them.

### 5.1 Arrow Functions Only

No `function` declarations — use `const` + arrow function.

``` ts
// ❌ Lint error
function foo() {
  return 1;
}

// ✅ Correct
const foo = (): number => 1;
```

### 5.2 No Inline Exports

Write `export` as a separate statement.

``` ts
// ❌ Lint error
export const foo = 1;

// ✅ Correct
const foo = 1;
export { foo };
```

### 5.3 Single-Statement Braces Stripped

`if`/`for`/`while`/`do-while` with a single body statement should not
have braces.

``` ts
// ❌ After format, braces are stripped
if (done) {
  return;
}

// ✅ Correct
if (done)
  return;
```

### 5.4 Formatting Rules

| Setting           | Value         |
|-------------------|---------------|
| Quote style       | Double quotes |
| Indentation       | 2 spaces      |
| Line width        | 80 characters |
| Trailing commas   | All           |
| Semicolons        | Always        |
| Arrow parentheses | Always        |

## 6. Formatting Pipeline

If the linter complains about formatting, run:

``` bash
pnpm format
```

This runs four steps in order:

| Step            | Tool                    | What it does                                     |
|-----------------|-------------------------|--------------------------------------------------|
| `format:arrows` | `convert-to-arrow`      | Rewrites `function` declarations to arrow consts |
| `format:braces` | ast-grep `strip-braces` | Removes braces from single-statement blocks      |
| `format:biome`  | `biome format --write`  | Formats all files (indentation, quotes, etc.)    |
| `format:check`  | `biome check --write`   | Applies lint auto-fixes                          |

## 7. Linting Pipeline

`pnpm lint` runs four checks in sequence:

| Step             | Tool          | What it checks                                                    |
|------------------|---------------|-------------------------------------------------------------------|
| `lint:biome`     | `biome check` | Format, lint, and import-order violations (no writes)             |
| `lint:oxlint`    | `oxlint`      | Type-aware rules: no-floating-promises, return-await, unused-vars |
| `lint:exports`   | ast-grep      | No inline `export` keywords                                       |
| `lint:functions` | ast-grep      | No `function` declarations                                        |

### oxlint Rules

The `.oxlintrc.json` enables type-aware checking:

- `no-unused-vars` — errors on unused variables (except `_`-prefixed
  args)
- `typescript/no-floating-promises` — all promises must be awaited or
  handled
- `typescript/return-await` — `return await` required inside try-catch

### Biome Rules

`biome.json` uses `"preset": "none"` with hand-picked rules across four
categories: `complexity`, `correctness`, `style`, and `suspicious`.
Notable enforcements:

- `useArrowFunction` — arrow functions over function expressions
- `useConst` — `const` over `let` when never reassigned
- `noExplicitAny` — no `any` type
- `useConsistentArrowReturn` — omit `return` for single-expression
  arrows
- `noEmptyBlockStatements` — no empty `{}` blocks

## 8. Testing

Tests live in `src/tests/` with filenames ending in `.test.ts`.

``` bash
pnpm test         # run all tests
pnpm test:watch   # watch mode
```

The Vitest config (`vitest.config.ts`) includes
`src/tests/**/*.test.ts`.

## 9. CI/CD

### `ci.yml`

Runs on every pull request:

1.  **Checkout** code
2.  **Setup** pnpm 11.8.0 + Node 24
3.  **Install** dependencies (`--frozen-lockfile`)
4.  **Build** (`pnpm build`)
5.  **Lint** (`pnpm lint`)
6.  **Test** (`pnpm test`)

### `copilot-setup-steps.yml`

Provisions the environment for GitHub Copilot’s coding agent:

1.  **Checkout** code
2.  **Setup** pnpm 11.8.0 + Node 24
3.  **Install** dependencies (`--frozen-lockfile`)

Runs when the workflow file itself changes, or via manual dispatch.

## 10. TypeScript Configuration

| Setting             | Value      | Purpose                            |
|---------------------|------------|------------------------------------|
| `target`            | `ES2025`   | Output JS target                   |
| `module`            | `ESNext`   | ESM modules                        |
| `moduleResolution`  | `bundler`  | Modern resolution strategy         |
| `strict`            | `true`     | Full type checking                 |
| `noEmit`            | `true`     | Type-check only — use `tsx` to run |
| `resolveJsonModule` | `true`     | Allow JSON imports                 |
| `types`             | `["node"]` | Node.js type definitions           |

## 11. Extending the Template

### Add a New Module

1.  Create `src/my-module.ts`.
2.  Export with separate `export { }` statement.
3.  Add tests in `src/tests/my-module.test.ts`.
4.  Run `pnpm build && pnpm lint && pnpm test`.

### Add Runtime Dependencies

The template has zero runtime dependencies. Add what you need:

``` bash
pnpm add <package>
```

### Change Node Version

Update both `package.json` (`engines.node`) and
`.github/workflows/ci.yml` (`node-version`).

### Disable a Convention

To stop enforcing a structural rule, remove the corresponding file in
`.ast-grep/rules/` and its script entry in `package.json`.
