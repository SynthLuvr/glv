import { createReadStream, type Stats } from "node:fs";
import { createStreamBody } from "@hono/node-server/utils/stream";
import { type Context } from "hono";
import { getMimeType } from "hono/utils/mime";

// Vendored from the @hono/node-server fork this project dropped: the stock
// package exports no sendFile, and its serveStatic re-resolves request paths
// and ignores If-Modified-Since. This local copy serves an already-validated
// absolute path with the fork's wire behavior — extension-derived
// Content-Type, Content-Length, Last-Modified, conditional 304s, HEAD/OPTIONS,
// and single byte-range requests — streamed from disk, never buffered.

// false pins the manual stream pump; the default switches to Readable.toWeb
// on newer Node versions, which changes the bridge across runtimes.
const fileBody = (
  path: string,
  range?: { start: number; end: number },
): ReadableStream<Uint8Array> =>
  range === undefined
    ? createStreamBody(createReadStream(path), false)
    : createStreamBody(
        createReadStream(path, { start: range.start, end: range.end }),
        false,
      );

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
  c: Context,
  path: string,
  range: string,
  size: number,
): Response => {
  c.header("Accept-Ranges", "bytes");
  // A malformed Range header serves the whole file, as serveStatic always did.
  const spec: ByteRangeSpec = parseByteRange(range) ?? {
    type: "open-ended",
    start: 0,
  };
  const resolved = resolveByteRange(spec, size);
  if (resolved === undefined) {
    c.header("Content-Range", `bytes */${size}`);
    return c.body(null, 416);
  }
  c.header("Content-Length", (resolved.end - resolved.start + 1).toString());
  c.header("Content-Range", `bytes ${resolved.start}-${resolved.end}/${size}`);
  return c.body(fileBody(path, resolved), 206);
};

const fileResponse = (c: Context, path: string, size: number): Response => {
  if (c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    c.header("Content-Length", size.toString());
    c.status(200);
    return c.body(null);
  }
  const range = c.req.header("range");
  if (range !== undefined) return rangeResponse(c, path, range, size);
  c.header("Content-Length", size.toString());
  return c.body(fileBody(path), 200);
};

// The caller owns the safety checks (containment, dotfile and symlink rules
// — see browse.tsx) and passes the stats it validated against, so the file
// is never re-resolved.
const sendFile = (c: Context, path: string, stats: Stats): Response => {
  c.header("Content-Type", getMimeType(path) ?? "application/octet-stream");
  c.header("Last-Modified", stats.mtime.toUTCString());

  // RFC 9110: If-Modified-Since applies only to GET/HEAD and is ignored when
  // If-None-Match is present.
  const ifModifiedSince = c.req.header("if-modified-since");
  if (
    ifModifiedSince !== undefined &&
    c.req.header("if-none-match") === undefined &&
    (c.req.method === "GET" || c.req.method === "HEAD") &&
    isNotModifiedSince(ifModifiedSince, stats.mtimeMs)
  ) {
    // A 304 carries no representation metadata, so the Content-Type set
    // above is dropped; Last-Modified stays to guide cache updates
    // (RFC 9110 §15.4.5).
    c.header("Content-Type", undefined);
    return c.body(null, 304);
  }

  return fileResponse(c, path, stats.size);
};

export { sendFile };
