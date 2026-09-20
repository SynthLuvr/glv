# ADR 0006: HTTP layer on Fastify (from Hono)

- Status: Accepted
- Date: 2026-09-18
- Revised: 2026-09-20 — rationale recorded in full
- Deciders: glv maintainers
- Relates to: [ADR 0001](0001-choose-hono-over-elysia.md) (supersedes
  its “stay with Hono” decision for the HTTP layer only; its reasoning
  about not adopting Elysia is unaffected)

## Context

glv’s server is htmx-driven: server-rendered JSX fragments, SSE streams
for live runs, passkey auth with cookie sessions and a redirect gate,
and streamed file delivery for the browser. Until now the HTTP layer was
Hono served through `@hono/node-server`.

ADR 0001 kept Hono on two legs: its built-ins (JSX, streaming, cookies,
node-server) mapped exactly onto this workload, and its Web-standard,
dependency-free design kept glv portable across runtimes. Both legs have
since weakened in practice:

- **The SSE dependency broke.** glv’s SSE contract needs two semantics
  `streamSSE` does not provide: reading the `Last-Event-ID` header an
  `EventSource` sends on reconnect, and writes after a client disconnect
  resolving as no-ops instead of throwing or hanging. This is upstream
  [honojs/hono#3765](https://github.com/honojs/hono/issues/3765) (“SSE
  does not work again…”, filed December 2024). For three weeks glv ran
  git forks of `hono` and `@hono/node-server` carrying its own open
  upstream PRs (honojs/hono#5289, honojs/node-server#395). The pins
  could not track upstream security releases — three advisories patched
  in `>=4.13.5` had to be ignored in CI while the fork base stayed
  vulnerable — so on 2026-09-18 the forks were dropped and the fixes
  vendored into the repo (`server/sse.ts`, `server/send-file.ts`). That
  left glv owning transport code upstream had declined to take, with no
  path back to registry builds that behave correctly.
- **The portability argument lost its consumer.** glv’s server is
  Node-only by intent — Node via tsx, as ADR 0001’s own context records
  — and there is no plan to run it on workers, Deno, or Bun. Hono’s
  runtime-agnostic handlers are an option glv does not intend to
  exercise.

A migration to Fastify was executed to resolve the first problem at its
root and to evaluate the trade-off concretely rather than in the
abstract.

## Decision

Serve HTTP with **Fastify** (v5), with `@fastify/cookie`,
`@fastify/formbody`, `@fastify/multipart`, and `@fastify/sse` for the
pieces Hono ships in the core package.

**Keep `hono/jsx` as the view renderer.** Hono’s HTTP server is gone;
`hono/jsx` (with `hono/jsx/dom/server`’s `renderToString`) remains the
JSX runtime that renders every view — it is a standalone string
renderer, not tied to the framework. Swapping it (e.g. for Preact +
`preact-render-to-string`) would be a separate decision with its own
risk profile (18 view files, `raw()` HTML injection, exact byte-level
HTML the SSE contract tests pin).

## Rationale

Four reasons, in descending weight.

### 1. Hono upstream is not accepting the fixes glv needs

The one piece of Hono this app leans on hardest — `streamSSE`’s
lifecycle — is the piece upstream will not fix. The fix PR for the SSE
lifecycle bug (honojs/hono#5289, carrying `lastEventId` exposure and
no-op writes after `abort()`) was closed unmerged on 2026-09-20 by the
maintainer, without engaging with its content; the `sendFile` PR
(honojs/node-server#395, fixing feature request \#205) sat open and
unreviewed for a month. The workarounds available to a dependent were
each exhausted in turn and each failed:

- **Local workarounds** kept breaking on the framework’s own lifecycle
  (writes-after-disconnect throwing or hanging under the stock writer).
- **Forks** carry the fixes but strand security patches, and were
  dropped within three weeks for exactly that reason.
- **Vendoring** grows unowned code on the most wire-sensitive paths in
  the app, with no exit: the fixes will not land upstream.

If the fixes will not be accepted, the only durable resolution is to
stop depending on that code. `@fastify/sse` replaced the vendored SSE
writer within two days of the fork drop, shrinking `server/sse.ts` to a
facade.

### 2. Fastify’s development is more active where it matters

Both projects push commits frequently; the difference that matters to a
dependent is review and merge throughput. Fastify’s open issue backlog
is a fraction of Hono’s (166 vs 393 on 2026-09-20), its PRs are reviewed
and merged rather than closed unmerged, and its plugin ecosystem is
maintained by the Fastify org with its own release cadence —
demonstrated in this migration by adopting `@fastify/sse` (v0.6.0) as a
maintained dependency in place of a hand-rolled writer.

### 3. Fastify is the more mature framework

Fastify has a decade of production hardening behind a stable core, a
scoped plugin and lifecycle-hook model (onRequest/preValidation/…) with
well-defined encapsulation, and org-maintained plugins for every concern
glv needs — cookies, form bodies, multipart, SSE — plus the ones it will
likely need next (rate limiting, static files, websockets). Maturity
here is concrete: the framework’s behavior at the edges (body parsing,
serialization, hostname resolution) is documented and deterministic,
which the migration’s special-casing section below relies on.

### 4. glv is Node-bound, so Hono’s portability is worth nothing here

Hono’s Web-standard handlers can run on any runtime; Fastify’s
reply-mutating handlers cannot. That difference was a benefit only if a
non-Node runtime was on the table. It is not, and is not planned to be:
glv is a self-hosted Node server, and intends to remain one. Paying for
a portability abstraction (Response objects mediating every exchange
with a Node server) to preserve an option we do not intend to exercise
is the same uncompensated-overhead logic ADR 0001 used against Elysia,
applied consistently. Conversely, this makes the Node coupling explicit
and permanent rather than accidental.

The migration cost was also made concrete before deciding: 26 files,
+1981/−865, with every wire byte — HTML markup, SSE frames, file bytes,
cookies, redirect targets — pinned by the integration contract suites,
so the swap was verified end to end against a running server rather than
argued in the abstract.

## What changed in the migration

- Handlers move from returning Web-standard `Response` objects
  (`c.html(el)`, `c.json(obj, 400)`, `c.redirect(...)`) to mutating
  Fastify replies (`sendHtml(reply, el, 422)`, `reply.status(400)`,
  `reply.redirect(...)`).
- `hono/streaming`’s `streamSSE` is replaced by **`@fastify/sse`**
  (routes opt in with `sse: "only"`): the plugin serializes frames,
  honors backpressure, and closes the response when the handler
  resolves. `server/sse.ts` remains only as a thin facade over
  `reply.sse`, preserving the fork semantics this project depends on —
  the `Last-Event-ID` reconnect cursor and writes-after-disconnect
  becoming no-ops (the plugin throws `FST_ERR_SSE_CONNECTION_CLOSED`
  there; the facade catches exactly that). Heartbeats are disabled (the
  poll loops bound their own lifetimes, and a heartbeat comment would be
  wire bytes this app has never sent) and the serializer is the identity
  because payloads arrive pre-serialized and validated by `sse-events`.
- `parseBody({ all: true })` is replaced by `server/forms.ts`, which
  normalizes `@fastify/formbody` and `@fastify/multipart`
  (attachFieldsToBody) output into the same string/File record shape the
  handlers already consumed.
- The vendored `sendFile` now writes node streams through Fastify
  replies and hijacks the no-body responses (HEAD/OPTIONS/304/416).
- The auth gate is an `onRequest` hook registered inside the route scope
  (after `@fastify/cookie`’s parse hook), replacing
  `app.use("*", middleware)`.
- `serve` binds the same IPv6 wildcard `::` the node-server did, and
  shutdown tracks/destroys sockets on `app.server` as before.

Three Fastify defaults diverge from the app’s pinned wire behavior and
are handled explicitly:

1.  `request.hostname` drops the port, which breaks WebAuthn origin
    verification on non-standard ports — `resolveRequestUrl` builds the
    URL from the `Host` header, with `X-Forwarded-*` first-value
    handling, as before.
2.  Malformed JSON is rejected pre-handler with Fastify’s error shape
    instead of the verify endpoints’ `{verified:false,...}` — the
    `application/json` content parser now hands handlers the raw string,
    and `server/webauthn-json.ts` parses leniently, leaving deeper shape
    validation to `@simplewebauthn`, whose errors surface as the
    endpoints’ friendly 400s.
3.  `send(null)` serializes to a JSON `"null"` body with an
    `application/json` content type — body-less responses
    (HEAD/OPTIONS/304/416 on `/files`) bypass the serializer via
    hijacked raw writes.

## Consequences

Positive:

- The SSE dependency sits on maintained code: `@fastify/sse` owns
  framing, backpressure, and close semantics, so the vendored writer and
  its fork lineage are gone, and future fixes are registry bumps rather
  than vendored patches.
- First-class plugin ecosystem maintained by the Fastify org (cookies,
  forms, multipart, plus anything future: rate limiting, static files,
  websockets) with a review and release cadence Hono upstream did not
  give glv’s transport needs.
- Encapsulated scopes and lifecycle hooks (onRequest/preValidation/…)
  give the auth gate a cleaner home than a wildcard middleware.
- Fastify’s `request.body is unknown` forced the WebAuthn JSON boundary
  through explicit structural validation (`server/webauthn-json.ts`)
  where Hono’s `req.json()` returned `any` silently.
- The Node coupling is now a recorded decision rather than an unexamined
  accident.

Negative:

- Five dependencies (fastify + four plugins) replace one, each on its
  own release cadence.
- The Response-object style is gone: handlers are coupled to Fastify’s
  reply API. Leaving Node would now mean re-migrating the HTTP layer,
  not relaunching — acceptable only because the Node-only intent above
  is deliberate.
- Body-parsing limits need explicit care (bodyLimit raised so the
  friendly upload-size errors in `saveUploads` surface instead of a
  framework 413).
- `hono` remains a dependency for the JSX runtime — the migration is
  HTTP-layer-only, not a full decoupling from the package.

## When to revisit

Reconsider this decision if either trigger fires:

- **glv targets a non-Node runtime.** ADR 0001’s portability argument
  resurfaces in full, and the HTTP layer should be re-decided alongside
  it.
- **Fastify’s maintenance falters the way Hono’s did** — fixes closing
  unmerged, security releases unreachable from pinned versions. The thin
  facades this migration kept (`server/http.ts`, `server/forms.ts`,
  `server/sse.ts`, `server/send-file.ts`) are the seams to migrate
  behind again.

## References

- Migration PR: [\#281](https://github.com/SynthLuvr/glv/pull/281)
  (branch `fastify-migration`, 26 files, +1981/−865).
- The fork era: [\#214](https://github.com/SynthLuvr/glv/pull/214)
  (adopt forks carrying open upstream PRs),
  [\#280](https://github.com/SynthLuvr/glv/pull/280) (drop forks, vendor
  fixes), and the CI advisory ignores required while fork-pinned.
- Upstream:
  [honojs/hono#3765](https://github.com/honojs/hono/issues/3765) (SSE
  lifecycle bug, December 2024),
  [honojs/hono#5289](https://github.com/honojs/hono/pull/5289) (fix PR,
  closed unmerged 2026-09-20),
  [honojs/node-server#205](https://github.com/honojs/node-server/issues/205)
  (sendFile request, open),
  [honojs/node-server#395](https://github.com/honojs/node-server/pull/395)
  (fix PR, open since August 2026).
