import type { FastifyReply, FastifyRequest } from "fastify";
import type { Child } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";

// Structural guard shared by the request-boundary parsers (query strings,
// form bodies, JSON bodies) so no value is trusted beyond its runtime shape.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isHtmxRequest = (request: FastifyRequest): boolean =>
  request.headers["hx-request"] === "true";

// Node collects repeated headers into arrays; every header read is a
// single-value read, so take the first.
const headerValue = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

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

const serveAsset = (
  reply: FastifyReply,
  body: string,
  contentType: string,
): FastifyReply =>
  reply
    .status(200)
    .header("Content-Type", contentType)
    .header("Cache-Control", "public, max-age=86400")
    .send(body);

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

// Byte-parity with the framework's previous plain-text 404 body.
const sendNotFound = (reply: FastifyReply): FastifyReply =>
  reply.status(404).type("text/plain; charset=utf-8").send("404 Not Found");

export {
  extractIds,
  headerValue,
  isHtmxRequest,
  isRecord,
  queryValue,
  sendHtml,
  sendNotFound,
  serveAsset,
};
