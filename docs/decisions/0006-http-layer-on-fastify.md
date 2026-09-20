# ADR 0006: HTTP layer on Fastify (from Hono)

- Status: Accepted
- Date: 2026-09-18
- Deciders: glv maintainers
- Relates to: [ADR 0001](0001-choose-hono-over-elysia.md) (supersedes
  its “stay with Hono” decision for the HTTP layer only; its reasoning
  about not adopting Elysia is unaffected)

## Context

glv’s server is htmx-driven: server-rendered JSX fragments, SSE streams
for live runs, passkey auth with cookie sessions and a redirect gate,
and streamed file delivery for the browser. Until now the HTTP layer was
Hono served through `@hono/node-server`.

A migration to Fastify was requested and executed to evaluate the
trade-off concretely rather than in the abstract.

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

## What changed in the migration

- Handlers move from returning Web-standard `Response` objects
  (`c.html(el)`, `c.json(obj, 400)`, `c.redirect(...)`) to mutating
  Fastify replies (`sendHtml(reply, el, 422)`, `reply.status(400)`,
  `reply.redirect(...)`).
- `hono/streaming`’s `streamSSE` is replaced by **`@fastify/sse`** (routes
  opt in with `sse: "only"`): the plugin serializes frames, honors
  backpressure, and closes the response when the handler resolves.
  `server/sse.ts` remains only as a thin facade over `reply.sse`,
  preserving the fork semantics this project depends on — the
  `Last-Event-ID` reconnect cursor and writes-after-disconnect becoming
  no-ops. Heartbeats are disabled (the poll loops bound their own
  lifetimes, and a heartbeat comment would be wire bytes this app has
  never sent) and the serializer is the identity because payloads arrive
  pre-serialized and validated by `sse-events`.
- `parseBody({ all: true })` is replaced by `server/forms.ts`, which
  normalizes `@fastify/formbody` and `@fastify/multipart`
  (attachFieldsToBody) output into the same string/File record shape the
  handlers already consumed.
- The vendored `sendFile` now writes node streams through Fastify
  replies and hijacks the no-body responses (HEAD/OPTIONS/304/416) —
  Fastify’s serializer would otherwise turn a `null` payload into a JSON
  `"null"` body with an `application/json` content type.
- The auth gate is an `onRequest` hook registered inside the route scope
  (after `@fastify/cookie`’s parse hook), replacing
  `app.use("*", middleware)`.
- `serve` binds the same IPv6 wildcard `::` the node-server did, and
  shutdown tracks/destroys sockets on `app.server` as before.

## Consequences

Positive:

- First-class plugin ecosystem maintained by the Fastify org (cookies,
  forms, multipart, plus anything future: rate limiting, static files,
  websockets).
- Encapsulated scopes and lifecycle hooks (onRequest/preValidation/…)
  give the auth gate a cleaner home than a wildcard middleware.
- Fastify’s `request.body is unknown` forced the WebAuthn JSON boundary
  through explicit structural validation (`server/webauthn-json.ts`)
  where Hono’s `req.json()` returned `any` silently.

Negative:

- Five dependencies (fastify + four plugins) replace one.
- The Response-object style is gone: handlers are coupled to Fastify’s
  reply API, and the app can no longer run on non-Node runtimes
  (workers/deno/bun) the way Hono’s Web-standard handlers could.
- Body-parsing limits need explicit care (bodyLimit raised so the
  friendly upload-size errors in `saveUploads` surface instead of a
  framework 413).
- `hono` remains a dependency for the JSX runtime — the migration is
  HTTP-layer-only, not a full decoupling from the package.

The full benefit/disadvantage assessment lives in the migration PR’s
description.
