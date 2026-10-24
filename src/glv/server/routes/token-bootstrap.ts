import { type } from "arktype";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { API_TOKEN_NAME_ERROR, ApiTokenName } from "../../auth/db.js";
import { parseJson } from "../../parse.js";
import type { ServerContext } from "../context.js";
import { fieldString, parseForm } from "../forms.js";
import { headerValue } from "../http.js";

// The loopback-only HTTP bootstrap for API tokens (issue #365). Agents
// with network reach to a served viewer but no filesystem access to the
// data directory — SSH port-forwards, sibling containers, CI executors —
// cannot run `glv token create`; with --allow-token-bootstrap they mint
// their first bearer credential over HTTP, then everything rides the
// normal API.
//
// The endpoint must answer without any credential (a credential is what
// it mints), so its reachability is bounded by network position instead:
// registered only when the flag is on (off, the path is indistinguishable
// from any unknown /api route), and decided on the TCP peer's socket
// address — never x-forwarded-* headers, which any client can forge and
// every reverse proxy overwrites. That is also the proxy trap: behind a
// proxy every request arrives from the proxy's own loopback hop, so
// proxied deployments must not enable the flag (serve warns at boot; the
// README says the same).

// The peer decision, socket address only. serve binds "::", so IPv4
// peers arrive IPv4-mapped ("::ffff:127.0.0.1"), localhost-resolving
// clients as "::1", and an IPv4-only bind would hand over plain
// "127.0.0.1" — all three are loopback; anything else (including no
// address at all) is not.
const isLoopbackAddress = (address: string | undefined): boolean =>
  address === "127.0.0.1" ||
  address === "::1" ||
  address === "::ffff:127.0.0.1";

const LOOPBACK_ERROR =
  "Token bootstrap is limited to loopback peers (127.0.0.1 / ::1).";

const OWNER_ERROR =
  "This app has no owner yet — register a passkey once, then mint tokens.";

// A bound on a credential-less minting surface: a rolling one-minute
// window of successful mints held in process memory. The loopback gate
// is the security boundary; this valve just stops a runaway script from
// minting an unbounded pile of 30-day bearer tokens in one boot.
const MINT_WINDOW_MS = 60_000;
const MINTS_PER_WINDOW = 10;

const RATE_ERROR =
  `Token bootstrap is limited to ${MINTS_PER_WINDOW} mints ` +
  "per minute; retry shortly.";

const makeMintValve = (): {
  allow: () => boolean;
  record: () => void;
} => {
  const mints: number[] = [];
  const allow = (): boolean => {
    const cutoff = Date.now() - MINT_WINDOW_MS;
    while (mints[0] !== undefined && mints[0] <= cutoff) mints.shift();
    return mints.length < MINTS_PER_WINDOW;
  };
  return { allow, record: () => void mints.push(Date.now()) };
};

// Programmatic clients send one field; accept both the urlencoded /
// multipart spelling the rest of the write API uses and a JSON object,
// so `curl -d name=ci`, `curl -F name=ci`, and
// `curl -H 'content-type: application/json' -d '{"name":"ci"}'` all
// work. Malformed or non-matching JSON reads as no name (422 below) —
// the same fate as a missing form field.
const JsonNameBody = type({ "name?": "string" });

const readName = async (request: FastifyRequest): Promise<string> => {
  const contentType =
    headerValue(request.headers["content-type"])?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    if (typeof request.body !== "string") return "";
    const parsed = parseJson(request.body, JsonNameBody);
    return parsed.ok ? (parsed.data.name ?? "") : "";
  }
  return fieldString(await parseForm(request), "name");
};

// Registered at the app root — ahead of the auth-gated scope — because
// answering without a credential is the entire point; inside the scope
// the gate would 401/redirect every bootstrap request before the
// handler runs. No-op unless serve was started with the flag, so the
// default server never has the route at all.
const registerTokenBootstrapRoute = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  if (!ctx.allowTokenBootstrap) return;
  const valve = makeMintValve();
  app.post("/api/tokens", async (request, reply) => {
    // Security before body parsing: the peer decision is the TCP
    // socket's remote address, and nothing else (see the module note).
    if (!isLoopbackAddress(request.raw.socket.remoteAddress))
      return reply.status(403).send({ error: LOOPBACK_ERROR });
    const name = ApiTokenName(await readName(request));
    if (name instanceof type.errors)
      return reply.status(422).send({ error: API_TOKEN_NAME_ERROR });
    if (!valve.allow()) return reply.status(429).send({ error: RATE_ERROR });
    // The same minting call the browser page and `glv token create` use
    // (hash-only storage, fixed 30-day TTL, last_used_at audit trail);
    // undefined means there is no owner to attach the token to.
    const token = ctx.auth?.createApiToken(name);
    if (token === undefined)
      return reply.status(409).send({ error: OWNER_ERROR });
    valve.record();
    // The plaintext token crosses the wire exactly this once.
    return reply.status(201).send({ token, name });
  });
};

export { isLoopbackAddress, registerTokenBootstrapRoute };
