import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Child } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";

// Structural guard shared by the request-boundary parsers (query strings,
// form bodies, JSON bodies) so no value is trusted beyond its runtime shape.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Node collects repeated headers into arrays; every header read is a
// single-value read, so take the first.
const headerValue = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

const isHtmxRequest = (request: FastifyRequest): boolean =>
  headerValue(request.headers["hx-request"]) === "true";

// Fastify's default query parser yields strings and string arrays (repeated
// keys); route code always wants the first value, like Hono's req.query().
const queryValue = (
  request: FastifyRequest,
  key: string,
): string | undefined => {
  const query: unknown = request.query;
  if (!isRecord(query)) return undefined;
  const value: unknown = query[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
};

const extractIds = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
};

// Assets answer with a strong ETag and no-cache: the browser may store
// the response but must revalidate before reuse. An unversioned asset
// URL plus a long blind freshness window (the old public, max-age=86400)
// let one bad or truncated response poison the browser for a day — the
// styling-disappears-after-a-while report — and kept a rebuilt server's
// new stylesheet unseen until that window lapsed. Revalidation turns
// both into one cheap 304 when nothing changed, and heals any stale or
// poisoned entry on the next load.
const etagOf = (body: string): string =>
  `"${createHash("sha256").update(body).digest("hex")}"`;

// RFC 9110 If-None-Match: a comma-separated candidate list, weak tags
// compared on their opaque value, "*" matching whatever exists.
const etagMatches = (ifNoneMatch: string, etag: string): boolean => {
  const candidates = ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim());
  if (candidates.includes("*")) return true;
  return candidates.some((candidate) => candidate.replace(/^W\//, "") === etag);
};

// Body-less responses (304 here, HEAD/OPTIONS/416 in send-file.ts) bypass
// Fastify's serializer — it would turn a null payload into a JSON "null"
// body with an application/json content type — and write the exact wire
// bytes instead.
const sendNotModified = (reply: FastifyReply, etag: string): FastifyReply => {
  reply.hijack();
  reply.raw.writeHead(304, {
    ETag: etag,
    "Cache-Control": "no-cache",
  });
  reply.raw.end();
  return reply;
};

const serveAsset = (
  reply: FastifyReply,
  body: string,
  contentType: string,
): FastifyReply => {
  const etag = etagOf(body);
  const ifNoneMatch = headerValue(reply.request.headers["if-none-match"]);
  if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, etag))
    return sendNotModified(reply, etag);
  return reply
    .status(200)
    .header("Content-Type", contentType)
    .header("Cache-Control", "no-cache")
    .header("ETag", etag)
    .send(body);
};

// Serializes a hono/jsx child to an HTML string response — hono's
// c.html(el) equivalent, now explicit at each call site.
const sendHtml = (
  reply: FastifyReply,
  child: Child,
  status = 200,
): FastifyReply =>
  reply
    .status(status)
    .type("text/html; charset=utf-8")
    .send(renderToString(child));

const sendText = (
  reply: FastifyReply,
  body: string,
  status = 200,
): FastifyReply =>
  reply.status(status).type("text/plain; charset=utf-8").send(body);

// Byte-parity with the framework's previous plain-text 404 body.
const sendNotFound = (reply: FastifyReply): FastifyReply =>
  sendText(reply, "404 Not Found", 404);

export {
  extractIds,
  headerValue,
  isHtmxRequest,
  isRecord,
  queryValue,
  sendHtml,
  sendNotFound,
  sendText,
  serveAsset,
};
