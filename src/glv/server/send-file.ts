import { createReadStream, type Stats } from "node:fs";
import type { FastifyReply } from "fastify";
import { headerValue } from "./http.js";

// Vendored from @hono/node-server's serveStatic lineage (and now Fastify's
// reply): neither framework ships a sendFile that serves an
// already-validated absolute path with this wire behavior —
// extension-derived Content-Type, Content-Length, Last-Modified,
// conditional 304s, HEAD/OPTIONS, and single byte-range requests —
// streamed from disk, never buffered.

// The extension table hono/utils/mime carried, vendored so /files keeps
// byte-identical Content-Type headers for every extension it mapped.
const MIME_TYPES: Record<string, string> = {
  aac: "audio/aac",
  avi: "video/x-msvideo",
  avif: "image/avif",
  av1: "video/av1",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  eot: "application/vnd.ms-fontobject",
  epub: "application/epub+zip",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  ics: "text/calendar; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  jsonld: "application/ld+json",
  map: "application/json",
  mid: "audio/x-midi",
  midi: "audio/x-midi",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  oga: "audio/ogg",
  ogv: "video/ogg",
  ogx: "application/ogg",
  opus: "audio/opus",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  rtf: "application/rtf",
  svg: "image/svg+xml; charset=utf-8",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "video/mp2t",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webm: "video/webm",
  weba: "audio/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xhtml: "application/xhtml+xml",
  xml: "application/xml; charset=utf-8",
  zip: "application/zip",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  gltf: "model/gltf+json",
  glb: "model/gltf-binary",
};

const getMimeType = (path: string): string | undefined => {
  const match = path.match(/\.([a-zA-Z0-9]+?)$/);
  if (match === null) return undefined;
  return MIME_TYPES[match[1].toLowerCase()];
};

type ByteRangeSpec =
  | { type: "bounded"; start: number; end: number }
  | { type: "open-ended"; start: number }
  | { type: "suffix"; length: number };

type ByteRange = { start: number; end: number };

// One range like "bytes=4-11", "bytes=4-", "bytes=-8"; the "bytes=" prefix
// and an empty value are tolerated the way serveStatic always did.
const BYTE_RANGE_PATTERN = /^(?:bytes=)?(?!-$)(\d*)-(\d*)$/;

const parseByteRange = (range: string): ByteRangeSpec | undefined => {
  const match = range.match(BYTE_RANGE_PATTERN);
  if (match === null) return undefined;
  const [, start, end] = match;
  if (start === "") return { type: "suffix", length: Number(end) };
  if (end === "") return { type: "open-ended", start: Number(start) };
  return { type: "bounded", start: Number(start), end: Number(end) };
};

const resolveByteRange = (
  spec: ByteRangeSpec,
  size: number,
): ByteRange | undefined => {
  if (size === 0) return undefined;
  if (spec.type === "suffix") {
    if (spec.length === 0) return undefined;
    return { start: Math.max(size - spec.length, 0), end: size - 1 };
  }
  const end = spec.type === "bounded" ? Math.min(spec.end, size - 1) : size - 1;
  if (spec.start >= size || spec.start > end) return undefined;
  return { start: spec.start, end };
};

// HTTP dates only have second precision, so compare at second granularity.
const isNotModifiedSince = (
  ifModifiedSince: string,
  mtimeMs: number,
): boolean => {
  const sinceMs = Date.parse(ifModifiedSince);
  return (
    !Number.isNaN(sinceMs) &&
    Math.floor(mtimeMs / 1000) <= Math.floor(sinceMs / 1000)
  );
};

const rangeResponse = (
  reply: FastifyReply,
  path: string,
  range: string,
  size: number,
  meta: { contentType: string; lastModified: string },
): FastifyReply => {
  const headers: Record<string, string> = {
    "Content-Type": meta.contentType,
    "Last-Modified": meta.lastModified,
    "Accept-Ranges": "bytes",
  };
  // A malformed Range header serves the whole file, as serveStatic always did.
  const spec: ByteRangeSpec = parseByteRange(range) ?? {
    type: "open-ended",
    start: 0,
  };
  const resolved = resolveByteRange(spec, size);
  if (resolved === undefined)
    return sendHeadOnly(reply, 416, {
      ...headers,
      "Content-Range": `bytes */${size}`,
    });

  const length = resolved.end - resolved.start + 1;
  return reply
    .status(206)
    .headers({
      ...headers,
      "Content-Length": length.toString(),
      "Content-Range": `bytes ${resolved.start}-${resolved.end}/${size}`,
    })
    .send(createReadStream(path, resolved));
};

// Body-less responses (HEAD/OPTIONS/304/416) bypass Fastify's serializer —
// it would turn a null payload into a JSON "null" body with an
// application/json content type — and write the exact wire bytes instead.
const sendHeadOnly = (
  reply: FastifyReply,
  status: number,
  headers: Record<string, string>,
): FastifyReply => {
  reply.hijack();
  reply.raw.writeHead(status, headers);
  reply.raw.end();
  return reply;
};

const fileResponse = (
  reply: FastifyReply,
  path: string,
  size: number,
  meta: { contentType: string; lastModified: string },
): FastifyReply => {
  const headers: Record<string, string> = {
    "Content-Type": meta.contentType,
    "Last-Modified": meta.lastModified,
    "Content-Length": size.toString(),
  };
  const method = reply.request.method;
  if (method === "HEAD" || method === "OPTIONS")
    return sendHeadOnly(reply, 200, headers);

  const range = headerValue(reply.request.headers.range);
  if (range !== undefined) return rangeResponse(reply, path, range, size, meta);
  return reply.status(200).headers(headers).send(createReadStream(path));
};

// The caller owns the safety checks (containment, dotfile and symlink rules
// — see browse.tsx) and passes the stats it validated against, so the file
// is never re-resolved.
const sendFile = (
  reply: FastifyReply,
  path: string,
  stats: Stats,
): FastifyReply => {
  const meta = {
    contentType: getMimeType(path) ?? "application/octet-stream",
    lastModified: stats.mtime.toUTCString(),
  };
  const method = reply.request.method;
  const ifModifiedSince = headerValue(
    reply.request.headers["if-modified-since"],
  );

  // RFC 9110: If-Modified-Since applies only to GET/HEAD and is ignored when
  // If-None-Match is present.
  if (
    ifModifiedSince !== undefined &&
    headerValue(reply.request.headers["if-none-match"]) === undefined &&
    (method === "GET" || method === "HEAD") &&
    isNotModifiedSince(ifModifiedSince, stats.mtimeMs)
  )
    return sendHeadOnly(reply, 304, { "Last-Modified": meta.lastModified });

  return fileResponse(reply, path, stats.size, meta);
};

export { sendFile };
