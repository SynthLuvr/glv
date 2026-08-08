# ADR 0001: Use Hono rather than Elysia as the web framework

- Status: Accepted
- Date: 2026-08-08
- Deciders: glv maintainers

## Context

glv is a self-hosted web UI over goose session transcripts. Its
server-side workload is:

- Node 26, launched via tsx (`bin/glv`). It is not Bun.
- htmx-driven: the UI is server-rendered HTML fragments swapped over the
  wire. There is no typed API client.
- Server-side JSX that renders untrusted, user-controlled content
  (session names, prompts, markdown).
- Heavy Server-Sent Events usage for live-run streaming.
- Passkey auth backed by cookie sessions and a redirect gate.

The framework today is Hono. This decision records whether to keep it or
migrate to ElysiaJS.

To decide with evidence rather than intuition, we ran a complete,
throwaway migration to Elysia (branch `chore/replace-hono-with-elysia`)
and got it fully green: `pnpm build && pnpm lint && pnpm test` with 174
integration tests passing. The findings below come from that spike, not
from documentation.

## Decision

Stay with Hono.

## Alternative considered: ElysiaJS

Elysia is a Bun-first framework. Its defining strength is end-to-end
type safety (route schemas inferred through to a type-safe Eden client)
and typebox-based validation. The spike confirmed Elysia can run on Node
via `@elysiajs/node`, but the migration surfaced substantial friction
against this codebase’s real workload.

### Findings (each verified during the spike)

1.  **No auto-escaping JSX.** Elysia’s JSX (`@kitajs/html`) compiles to
    strings but does not escape dynamic children; it renders raw
    `<script>` verbatim. Hono/jsx escapes by default. Because glv
    renders user content everywhere, reproducing Hono’s security model
    required a 179-line custom JSX runtime rather than hand-escaping
    hundreds of interpolations.
2.  **No built-in SSE.** Hono ships `streamSSE`; Elysia does not. The
    spike reimplemented it over a `ReadableStream` (166 lines),
    including disconnect detection.
3.  **Content-Type defaulting.** Without its HTML plugin, Elysia serves
    every string body as `text/plain`, ignoring
    `set.headers['content-type']`. This silently broke CSS/JS assets and
    HTML pages alike. The remedy was to make every response helper
    return an explicit `Response` (110 lines).
4.  **`beforeHandle` only short-circuits on an inline return.** An auth
    gate written as an opaque call (`(c) => gate(c)`) does not redirect;
    only a textually inline `return new Response(...)` does. Elysia’s
    compile-time analysis wires the short-circuit solely when the
    Response is visible in the handler body.
5.  **Request body read once.** Calling `c.request.formData()` in a
    handler throws, because Elysia has already consumed the stream into
    `c.body`.
6.  **Invariant `Context` generics** make Elysia’s context unassignable
    across helpers; the spike introduced a structural `LooseContext`
    shim and in-place route registration to work around it.

### Cost summary

| Area                 | Hono (today)                      | Elysia (spike)                                    |
|----------------------|-----------------------------------|---------------------------------------------------|
| Runtime dependencies | 0 (dependency-free)               | 4 direct + adapter (~59 more transitive packages) |
| Auto-escaping JSX    | Built in (`hono/jsx`)             | 179-line custom runtime                           |
| SSE streaming        | Built in (`hono/streaming`)       | 166-line custom implementation                    |
| Cookie helpers       | Built in (`hono/cookie`)          | External `cookie` package                         |
| Response helpers     | `Context` methods                 | 110 lines of `Response` builders                  |
| Node adapter         | First-class (`@hono/node-server`) | `@elysiajs/node` (Bun is primary)                 |

Net, the migration added roughly 450 lines of framework-replacement code
that we would own and maintain, plus several behavioral workarounds, in
exchange for removing one well-fitting dependency.

## Consequences

- **Positive.** We keep a runtime-agnostic, dependency-free framework
  whose built-ins (JSX, streaming, cookies, node-server) map exactly
  onto a Node + htmx + SSR + SSE workload. No owned shims, no
  Node-adapter workarounds.
- **Negative.** We forgo Elysia’s end-to-end type-safe client story.
  This is acceptable because glv has no typed client; it is htmx, so
  that strength does not apply here.
- **Reversibility.** The decision carries no lock-in. The spike branch
  remains as a reference implementation.

## When to revisit

Reconsider Elysia if glv both (a) moves its runtime to Bun and (b)
shifts from htmx to a typed API client. At that point Elysia’s native
strengths (Bun `listen`, Eden type safety, schema validation) would
offset the friction recorded above.

## References

- Spike branch: `chore/replace-hono-with-elysia` (full Elysia migration;
  `pnpm build && pnpm lint && pnpm test` green, 174 integration tests).
