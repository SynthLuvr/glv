# ADR 0010: Evaluate the tsrs Rust port of TypeScript alongside tsc

- Status: Accepted
- Date: 2026-10-21
- Deciders: glv maintainers

## Context

Type-checking this repo (363 src files, ~43k LOC under `src/`,
`tsconfig.json` extending `ts-canon/presets/tsconfig.base.json`) runs
`tsc` from `typescript@7.0.2` — the Go port of the TypeScript compiler.

On 2026-10-20 Cloudflare and VoidZero announced
[tsrs](https://blog.cloudflare.com/typescript-rust-port/), a Rust port
of the TypeScript compiler, incubated inside the Oxc toolchain and
developed in collaboration with the TypeScript team. It is explicitly a
faithful port, not a fork: the TypeScript team keeps ownership of the
language, and tsrs follows its decisions (the port pins an exact
upstream snapshot — `0.18.0-ts7.1.0-dev.20260929` builds on
`microsoft/TypeScript@b85298b6a81f`, i.e. 7.1.0-dev.20260930.4). The
post calls the npm release experimental and names a known divergence:
the order in which diagnostics print.

Measured on this repo (Linux x64, 363 src files, medians of 3 runs after
warm-up; `pnpm bench:typecheck` reproduces this — values jitter a few
percent run to run):

| compiler                | wall   | user (CPU) | peak RSS |
|-------------------------|--------|------------|----------|
| tsc 7.0.2 (Go, current) | ~1.2s  | ~4.8s      | ~585 MB  |
| tsc 7.1.0-beta (Go)     | ~0.8s  | ~2.8s      | ~389 MB  |
| tsrs 0.18.0 (Rust)      | ~0.25s | ~1.2s      | ~225 MB  |

tsrs is ~5x faster than the 7.0.2 gate with ~63% less memory and ~75%
less CPU. It type-checks this tree clean (exit 0), resolves the exact
same 1053 files (363 project files, identical sets via
`--listFilesOnly`), and produces byte-identical diagnostics to both Go
builds on a 4-error fixture spanning two files — order included. Two
behavioral deltas were observed:

- Exit code on diagnostics-present runs: 7.0.2 exits 1, while 7.1.0-beta
  and tsrs exit 2. npm-run-all and CI only look at nonzero, so nothing
  downstream cares today.
- The published release is experimental; the upstream snapshot it pins
  (7.1.0-dev) is itself pre-beta.

## Decision

Adopt tsrs as an installed, **non-gating** second compiler:

- `pnpm check:tsrs` type-checks with tsrs; `pnpm check:tsc` is the
  explicit tsc counterpart. `pnpm build` still gates on tsc 7.0.2.
- CI gains a `tsrs` job (`continue-on-error: true`) running
  `pnpm check:tsrs` on every pull request, so divergence shows up as a
  visible-but-expected failure rather than a surprise or a blocked
  merge.
- `pnpm bench:typecheck` (`scripts/tsrs-eval.mts`) re-runs the benchmark
  and the diagnostics-parity check locally, so the numbers above stay
  reproducible as either compiler moves.
- The dependency is pinned exactly (`tsrs@0.18.0-ts7.1.0-dev.20260929`)
  and recorded in `minimumReleaseAgeExclude`, matching how this repo
  adopts young packages (ts-canon, tsx, croner).

Flip `build:typecheck` to tsrs — and make the CI job gating — only after
a tsrs stable release has held parity in the CI job across a meaningful
stretch of pull requests.

## Rationale

The numbers make tsrs the fastest and leanest way to type-check this
repo by a wide margin, and its stated goal — bit-for-bit fidelity with
upstream, validated against the TypeScript test suite — matches what we
observed on this tree. But the release is experimental, and the cost of
a silent compiler divergence in a project whose whole surface is
type-checked source (server, client scripts, JSX views) is a wrong
`pnpm build` verdict. Running both compilers keeps the stable gate while
making the experimental one observable on every PR for the price of one
extra cheap CI job (~10s of install + ~0.3s of checking). The harness in
`scripts/tsrs-eval.mts` covers the comparison itself, so the evaluate
part of this decision does not rot.

## Consequences

- Every PR gets a tsrs parity signal for free; a red-but-expected `tsrs`
  check is the early-warning system for divergence.
- Two native compilers ship in `node_modules` (~24 MB tsc + ~29 MB tsrs
  per platform); install size grows by one platform package.
- The `minimumReleaseAgeExclude` entry documents that a days-old package
  was accepted on purpose.
- When tsrs reaches stable and the CI history is clean, switching the
  gate is a one-line `build:typecheck` change plus making the CI job
  required — the decision to do so should revisit this ADR.
