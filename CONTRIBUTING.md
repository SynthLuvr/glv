# Contributing to glv

Thanks for your interest in improving glv. Bug reports, feature ideas,
and pull requests are all welcome.

This file covers how to set up a checkout and what a good pull request
looks like. The enforced coding conventions live in
[AGENTS.md](AGENTS.md) — the lint toolchain fails on violations, so it
is worth a skim before your first PR even if you never read it end to
end.

## Setup

Prerequisites:

- **Node.js 26** and **pnpm ≥ 12** — the exact pnpm version is pinned in
  `package.json`; Corepack honors the pin automatically.
- **pandoc ≥ 3.10** — the Markdown lint/format step canonicalizes every
  `.md` file in the repo.
- The **`goose`** and **`claude`** binaries only if you want to drive
  real sessions by hand; the test suite runs against a mock agent.

``` bash
pnpm install
pnpm build    # type-check + compile the stylesheet and client scripts
pnpm lint     # lint everything, including the Markdown files
```

## Reporting bugs and proposing features

Open a GitHub issue. Bug reports work best with: what you ran, what you
expected, what happened instead, the glv version, your OS, and — when
the server misbehaves — a `--debug` log. Check the existing issues (open
and closed) first. Feature ideas are discussed there before anyone
writes code.

## Pull requests

- **Open the PR early — a draft is fine.** Build and lint are fast and
  run locally before every push. The test suite is slow (every test file
  boots a real `glv serve` process plus a headless Chromium), so it runs
  in CI, in four parallel shards, on every push to an open pull request
  — including your very first one (GitHub asks a maintainer to approve
  the workflow run the first time).
- Markdown-only PRs skip CI entirely — see the `paths-ignore` list in
  `.github/workflows/ci.yml`.
- Keep PRs small and focused, and link the issue that motivated the
  change. If `pnpm lint` complains about formatting you cannot pin down,
  `pnpm format` canonicalizes everything, Markdown included.
- Commit subjects follow Conventional Commits — `feat(scope): …`,
  `fix(scope): …`, `docs(scope): …` — as `git log` shows.
- The pull request template carries the checklist CI enforces; the
  screenshot section can be deleted for changes with no user-visible
  surface.

## Tests

New behavior ships with an integration test that would fail without it:
real server processes on a free localhost port, real headless Chromium,
assertions over HTTP/SSE through the harness — no function mocks. The
shared suites live in `src/glv/tests/suites/` and are bound to the goose
and claude fixtures from `src/goose/tests/` and `src/claude/tests/`; a
genuinely flavor-specific test goes beside them. Coverage floors live in
`vitest.config.ts`, and CI fails when product code lands uncovered.

While iterating, run one file rather than the whole suite (CI covers the
rest on the PR):

``` bash
pnpm build:assets
pnpm exec vitest run src/goose/tests/turn-context.integration.test.ts
```

## UI changes

Every PR that changes something a user can see — views, styles, client
scripts, generated markup — ships before-and-after screenshots in the PR
description: `pnpm shots` builds the assets, boots a real server against
the mock agent with a seeded session, drives the UI with Playwright, and
writes PNGs to `pr-shots/` (gitignored). Drag the images into the PR
description so they upload as permanent
`github.com/user-attachments/assets/…` URLs — never commit image files
to the tree.

## Code of Conduct

Participation in the glv project is governed by the [Code of
Conduct](CODE_OF_CONDUCT.md); by taking part you are expected to uphold
it. Security issues follow [SECURITY.md](SECURITY.md) — please report
them privately rather than opening a public issue.
