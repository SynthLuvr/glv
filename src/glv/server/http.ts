import type { FastifyReply, FastifyRequest } from "fastify";
import type { ComponentChild } from "preact";
import { renderToString } from "preact-render-to-string";

// Response statuses the HTML layer produces. Narrow so typos surface at
// compile time instead of as a 500 at runtime.
type StatusCode = 200 | 302 | 400 | 403 | 404 | 409 | 422 | 500 | 502;

const isHtmxRequest = (req: FastifyRequest): boolean =>
  req.headers["hx-request"] === "true";

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
    .header("Content-Type", contentType)
    .header("Cache-Control", "public, max-age=86400")
    .code(200)
    .send(body);

// Render a JSX node and send it as HTML. A string node passes through
// untouched (fragment endpoints reply with "" so htmx clears slots).
// Returns the reply so handlers can `return sendHtml(...)`.
const sendHtml = (
  reply: FastifyReply,
  node: ComponentChild,
  status?: StatusCode,
): FastifyReply => {
  const html =
    typeof node === "string"
      ? node
      : renderToString(node as Parameters<typeof renderToString>[0]);
  reply.type("text/html; charset=utf-8");
  if (status !== undefined) reply.code(status);
  return reply.send(html);
};

// First value of a query parameter. The default query parser yields a
// string for single occurrences and an array for repeats.
const queryValue = (req: FastifyRequest, key: string): string | undefined => {
  const value = (req.query as Record<string, unknown>)[key];
  if (Array.isArray(value))
    return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
};

// URL-encoded path (query stripped) for prefix matching, mirroring
// req.path semantics — routing params are decoded, this is not.
const pathOf = (req: FastifyRequest): string => {
  const url = req.raw.url ?? "/";
  const queryAt = url.indexOf("?");
  return queryAt === -1 ? url : url.slice(0, queryAt);
};

// Route parameter as a string. Params arrive URI-decoded.
const param = (req: FastifyRequest, name: string): string => {
  const value = (req.params as Record<string, unknown>)[name];
  return typeof value === "string" ? value : "";
};

export type { StatusCode };
export {
  extractIds,
  isHtmxRequest,
  param,
  pathOf,
  queryValue,
  sendHtml,
  serveAsset,
};
