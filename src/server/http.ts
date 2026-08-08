import { renderToString } from "#jsx";

// Minimal structural view of an Elysia request context. Helpers depend only on
// these fields so any route handler's (inferred) context satisfies them
// without tripping Elysia's invariant Context generics.
type LooseContext = {
  body?: unknown;
  request: Request;
  set: {
    status?: number | string;
    headers: Record<string, string | number>;
  };
};

const isHtmxRequest = (c: LooseContext): boolean =>
  c.request.headers.get("hx-request") === "true";

const extractIds = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
};

// Builds the final Response, carrying forward anything set upstream on
// `c.set.headers` (notably the sliding-window Set-Cookie the auth gate writes
// for authenticated requests) and then applying the caller's explicit headers.
// Returning a concrete Response also pins Content-Type — without it Elysia
// defaults every string body to text/plain, breaking HTML/CSS/JS delivery.
const respond = (
  c: LooseContext,
  body: BodyInit | null,
  status: number | undefined,
  headers: Record<string, string>,
): Response => {
  const h = new Headers();
  for (const [key, value] of Object.entries(c.set.headers))
    h.set(key, String(value));
  for (const [key, value] of Object.entries(headers)) h.set(key, value);
  return new Response(body, { status: status ?? 200, headers: h });
};

const html = (c: LooseContext, node: unknown, status?: number): Response =>
  respond(c, renderToString(node), status, {
    "content-type": "text/html; charset=utf-8",
  });

const json = (c: LooseContext, data: unknown, status?: number): Response =>
  respond(c, JSON.stringify(data), status, {
    "content-type": "application/json; charset=utf-8",
  });

const text = (c: LooseContext, body: string, status?: number): Response =>
  respond(c, body, status, { "content-type": "text/plain; charset=utf-8" });

const redirect = (c: LooseContext, url: string, status = 302): Response =>
  respond(c, null, status, { location: url });

const notFound = (c: LooseContext): Response => respond(c, null, 404, {});

// Raw byte/string response with explicit headers (assets, empty 200s).
const send = (
  c: LooseContext,
  body: unknown,
  status?: number,
  headers?: Record<string, string>,
): Response => respond(c, body as BodyInit, status, headers ?? {});

const serveAsset = (
  c: LooseContext,
  body: string,
  contentType: string,
): Response =>
  send(c, body, 200, {
    "content-type": contentType,
    "cache-control": "public, max-age=86400",
  });

// Parses an urlencoded/multipart body into a plain record. With `all`, every
// field is an array of its values (Hono's parseBody({ all: true })); otherwise
// each field is its first value. File entries are preserved (not stringified)
// so upload handling receives real File objects.
// Normalizes Elysia's parsed body (c.body) into a plain record. With `all`,
// every field is an array (Hono parseBody({ all: true })); otherwise each
// field is its first value. File entries are preserved for upload handling.
const parseBody = async (
  c: LooseContext,
  all = false,
): Promise<Record<string, string | File | (string | File)[]>> => {
  const raw = (c.body ?? {}) as Record<string, unknown>;
  const out: Record<string, string | File | (string | File)[]> = {};
  for (const [key, value] of Object.entries(raw))
    if (all) out[key] = Array.isArray(value) ? value : [value];
    else out[key] = Array.isArray(value) ? (value[0] ?? "") : value;

  return out;
};

export type { LooseContext };
export {
  extractIds,
  html,
  isHtmxRequest,
  json,
  notFound,
  parseBody,
  redirect,
  send,
  serveAsset,
  text,
};
