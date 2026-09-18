# ADR 0001: Use Hono rather than Elysia as the web framework

- Status: Superseded by ADR 0006 (framework now Fastify; the Elysia
  findings below remain valid history)
- Date: 2026-08-08
- Deciders: glv maintainers

## Context

glv is a self-hosted web UI over goose session transcripts. Its
server-side workload is:

- Node 26, launched via tsx (`bin/glv-goose`). It is not Bun.
- htmx-driven: the UI is server-rendered HTML fragments swapped over the
  wire. There is no typed API client.
- Server-side JSX that renders untrusted, user-controlled content
  (session names, prompts, markdown).
- Heavy Server-Sent Events usage for live-run streaming.
- Passkey auth backed by cookie sessions and a redirect gate.

The framework today is Hono. This decision records whether to keep it or
migrate to ElysiaJS.

## Decision

Stay with Hono.

## Rationale

The decision rests on a single observation: **Elysia’s strengths do not
apply to this workload, so any migration cost is uncompensated
overhead.**

Elysia is a Bun-first framework whose headline feature is end-to-end
type safety — route schemas inferred at compile time and projected onto
a type-safe Eden client. Neither capability has a consumer in glv:

- **No Bun.** glv runs on Node 26 via tsx. The spike proved Elysia can
  run on Node through `@elysiajs/node`, but every piece of friction
  documented below — the adapter itself, the Content-Type quirks, the
  compile-time `beforeHandle` caveats — is Elysia-on-Node overhead that
  would not exist on Bun. Adopting Elysia means committing to a
  community-maintained Node adapter for a framework whose primary target
  is a different runtime.
- **No typed client.** glv is htmx-driven SSR. There is no API client,
  typed or otherwise. Elysia’s schema validation and Eden type inference
  have no consumer. We would be adopting a framework built around a
  feature we cannot use.

With no offsetting benefit, the migration’s cost — even after the
spike’s refactors halved it — is pure overhead. Hono, by contrast, is
dependency-free and its built-ins (JSX, streaming, cookies, node-server)
map exactly onto this workload.

## Alternative considered: ElysiaJS

A complete, throwaway migration to Elysia (branch
`chore/replace-hono-with-elysia`) was executed and brought to green:
`pnpm build && pnpm lint && pnpm test` with 175 integration tests
passing. After the initial migration, refactoring commits on the same
branch resolved the SSE finding and shrank the JSX runtime; the findings
below reflect the spike’s refined state.

### Findings (each verified during the spike)

1.  **JSX does not auto-escape by default.** Elysia’s JSX
    (`@kitajs/html`) compiles to strings but does not escape dynamic
    children; it renders raw `<script>` verbatim. Hono/jsx escapes by
    default. Because glv renders user content everywhere, reproducing
    Hono’s security model required a custom JSX runtime. After
    refinement, the runtime delegates escaping, attribute serialisation,
    and void-tag detection to `@kitajs/html`’s `escapeHtml`,
    `attributesToString`, and `isVoidElement` helpers (117 lines),
    retaining auto-escape-by-default via a `RawHtml` marker that passes
    trusted HTML through untouched. An integration test now asserts user
    prompts are HTML-escaped.
2.  **SSE — resolved during spike refinement.** The initial spike
    reimplemented SSE over a `ReadableStream` (166 lines), including
    disconnect detection, under the assumption that Elysia had no
    built-in streaming helper. A subsequent refactor replaced this with
    Elysia’s own `sse()` (`import { sse } from "elysia"`), which owns
    the `text/event-stream` headers, framing, and client-disconnect
    teardown. Net −155 lines across the SSE modules. Elysia does ship
    SSE; this finding no longer stands.
3.  **Content-Type defaulting.** Without its HTML plugin, Elysia serves
    every string body as `text/plain`, ignoring
    `set.headers['content-type']`. This silently broke CSS/JS assets and
    HTML pages alike. The remedy was to make every response helper
    return an explicit `Response` (106 lines). The browse route now
    reuses Elysia’s built-in extension-to-MIME map
    (`elysia/universal/file`) as a base, restating only the deltas
    (charset on text types, markdown), which the built-in table omits.
4.  **`beforeHandle` only short-circuits on an inline return.** An auth
    gate written as an opaque call (`(c) => gate(c)`) does not redirect;
    only a textually inline `return new Response(...)` does. Elysia’s
    compile-time analysis wires the short-circuit solely when the
    Response is visible in the handler body. This was re-verified during
    cleanup: extracting the gate into a helper silently passed every
    request through.
5.  **Request body read once.** Calling `c.request.formData()` in a
    handler throws, because Elysia has already consumed the stream into
    `c.body`.
6.  **Invariant `Context` generics** make Elysia’s context unassignable
    across helpers; the spike introduced a structural `LooseContext`
    shim and in-place route registration to work around it.

### Cost summary

| Area | Hono (today) | Elysia (spike) |
|----|----|----|
| Runtime dependencies | 0 (dependency-free) | 4 direct + adapter (~65 more transitive packages) |
| Auto-escaping JSX | Built in (`hono/jsx`) | 117-line wrapper over `@kitajs/html` |
| SSE streaming | Built in (`hono/streaming`) | Built in (`sse` from `elysia`) |
| Cookie helpers | Built in (`hono/cookie`) | External `cookie` package |
| Response helpers | `Context` methods | 106 lines of `Response` builders |
| Node adapter | First-class (`@hono/node-server`) | `@elysiajs/node` (Bun is primary) |

The refactored spike halved the framework-replacement cost — roughly 225
lines (down from ~450 in the initial migration), primarily by adopting
Elysia’s built-in `sse()`. The remaining 225 lines plus four behavioral
workarounds are all Elysia-on-Node quirks absent from Hono. That cost is
acceptable in isolation, but the rationale above makes it decisive: it
buys nothing the codebase can use.

## Consequences

- **Positive.** We keep a runtime-agnostic, dependency-free framework
  whose built-ins (JSX, streaming, cookies, node-server) map exactly
  onto a Node + htmx + SSR + SSE workload. No owned shims, no
  Node-adapter workarounds, no paying for type-safety features we have
  no consumer for.
- **Negative.** We forgo Elysia’s end-to-end type-safe client story.
  This is a non-cost: glv has no typed client; it is htmx.
- **Reversibility.** The decision carries no lock-in. The spike branch
  remains as a reference implementation and would be the starting point
  if the revisit triggers below are met.

## When to revisit

Reconsider Elysia if glv both (a) moves its runtime to Bun and (b)
shifts from htmx to a typed API client. At that point Elysia’s native
strengths (Bun `listen`, Eden type safety, schema validation) would
offset the friction recorded above. Absent both conditions, the overhead
documented here has no compensating benefit.

## References

- Spike branch: `chore/replace-hono-with-elysia` (full Elysia migration;
  `pnpm build && pnpm lint && pnpm test` green, 175 integration tests).
