# ADR 0006: Migrate the web framework from Hono to Fastify

- Status: Accepted
- Date: 2026-09-18
- Deciders: glv maintainers
- Supersedes: ADR 0001 (in part — the framework choice; ADR 0001’s
  Elysia findings remain valid history)

## Context

Since ADR 0001, glv’s server ran on Hono with two org-maintained forks
pinned in `package.json`:

- `hono` at `SynthLuvr/hono#dist/fix/sse-lifecycle-4.13.7` — carrying an
  SSE lifecycle fix not in any upstream release;
- `@hono/node-server` at `SynthLuvr/node-server#dist/open-prs` — a
  branch tracking open upstream PRs the app depends on.

That is two forks of upstream packages to rebase on every release, and
the forked surface (the Node adapter) is exactly the layer where the
bugs lived. ADR 0001 rejected Elysia because its strengths (Bun, typed
clients) had no consumer here; it did not evaluate Fastify, which is
Node-first and needs no adapter at all.

## Decision

Migrate the HTTP layer to Fastify (v5) with `@fastify/cookie`,
`@fastify/formbody`, and `@fastify/multipart`, and render the existing
server-side JSX with `preact` + `preact-render-to-string`. Drop Hono and
`@hono/node-server` (and both forks).

## What the migration replaced

Hono’s built-ins map directly onto this workload (ADR 0001’s central
point), so each one needed an equivalent:

| Capability | Hono (before) | Fastify (after) |
|----|----|----|
| HTTP server | forked `@hono/node-server` | Fastify itself (Node-first) |
| JSX → string | `hono/jsx` + `hono/jsx/dom/server` | `preact` + `preact-render-to-string` (+ 30-line type shim in `src/glv/jsx.ts`) |
| SSE | forked `hono/streaming` | ~55-line `SseStream` over `reply.raw` (`reply.hijack()`) |
| Cookies | `hono/cookie` | `@fastify/cookie` |
| Form/multipart parsing | `Request.formData()` via `parseBody` | `@fastify/formbody` + ~50-line `parseForm` preserving repeated-field array semantics |
| Auth gate | `app.use` middleware | `preHandler` hook |
| File delivery | forked `send-file` | ~60-line ranged sender + MIME table in `browse.tsx` |
| Status-code typing | `ContentfulStatusCode` | local `StatusCode` union |

Net: **+1602/−538 lines across 39 files**; roughly 300 lines of new
owned plumbing (SSE framing, form normalization, ranges, MIME) that Hono
shipped built-in.

## Verification

- `pnpm build && pnpm lint` green.
- Rendered output compared page-by-page against the Hono server over
  HTTP with identically seeded databases: **18/18 endpoints return
  status-identical, DOM-identical HTML** (jsdom-normalized; the only
  raw-byte difference is attribute escaping — Preact leaves `'` and `>`
  literal inside double-quoted attributes, which is HTML-equivalent).
- The full integration suite (57 shared suites × 2 flavors + flavor
  tests) runs unchanged in CI — tests are black-box over HTTP/SSE, so
  the migration is invisible to them by design.
- Boot time, RSS, and page-render latency measured within noise of the
  Hono server (boot ~1.5–1.6 s, RSS ~265 MB, home render p50 2.7 ms vs
  2.1 ms).

## Evaluation: was it worthwhile?

**Benefits realized**

1.  **No org-maintained forks.** Two forked dependencies (with rebases
    on every upstream release) reduce to zero; everything is stock
    upstream. The SSE lifecycle fix the Hono fork carried becomes moot —
    abort detection now rides on Node’s own `request.on("close")`.
2.  **No adapter layer.** Hono on Node goes through a Web-standard
    adapter; Fastify speaks Node natively. Fewer layers between routes
    and sockets, and the layer we keep is the most mainstream one in the
    Node ecosystem.
3.  **Larger plugin ecosystem** (`@fastify/*`), available if glv ever
    wants rate limiting, helmet-style headers, or metrics — nothing
    consumed today.

**Costs accepted**

1.  **~300 lines of owned plumbing** replacing Hono built-ins (SSE
    framing, form semantics, ranged file serving, MIME). This reverses
    the dependency-minimizing stance of ADR 0001: direct runtime deps go
    from 2 (both forks) to 6, though the lockfile footprint is a wash
    (296 → 297 packages).
2.  **`preact` enters the tree** for SSR only (no client vdom). It is
    small and `preact-render-to-string` is a mature renderer — arguably
    more battle-tested than `hono/jsx` — but it is a real dependency
    where before there was none.
3.  **Route code is slightly noisier**: `(req, reply)` pairs and typed
    param helpers instead of Hono’s single `Context` object; multipart
    parsing is explicit (`req.parts()` loop) instead of `parseBody`.

**Verdict**

A net positive, narrowly: the deciding factor is shedding the two forks,
not performance (a wash) or features (none consumed). If the upstream
PRs the forks track had already merged, staying on Hono would remain the
lower-cost option, exactly as ADR 0001 concluded. Anyone weighing a
repeat of this migration should re-check fork status first — if the
forks can be dropped without migrating, that is cheaper than this was.

## Consequences

- `package.json` pins upstream `fastify@^5`, `@fastify/cookie`,
  `@fastify/formbody`, `@fastify/multipart`, `preact`,
  `preact-render-to-string`; `hono` and `@hono/node-server` are gone.
- ADR 0001’s Elysia findings are historical; its “stay with Hono”
  decision is superseded by this ADR.
- `src/glv/jsx.ts` is the JSX boundary (types + custom-element
  augmentation); views import JSX surface types only from there, so a
  future renderer swap touches one file plus import lines.

## When to revisit

- If Fastify’s maintenance slows or a breaking v6 forces churn without
  benefit, Hono upstream (with the SSE fix merged) remains a viable
  return path — the JSX boundary and the small owned helpers were
  written to be portable.
- If glv moves to Bun (ADR 0001’s Elysia trigger), Fastify travels
  poorly (Node-first); that scenario reopens the framework question.
