import { createReadStream, type ReadStream, type Stats } from "node:fs";
import { type Context } from "hono";
import { getMimeType } from "hono/utils/mime";

// Vendored from @hono/node-server (the fork this project used to depend on,
// honojs/node-server "sendFile helper" + If-Modified-Since 304 + Range fixes;
// the stream bridge is upstream's createStreamBody). The fork is gone from
// the dependencies: this local copy serves a validated absolute path with
// the same wire behavior — extension-derived Content-Type, Content-Length,
// Last-Modified, conditional 304s, HEAD/OPTIONS, and single byte-range
// requests — streamed from disk, never buffered.

// Bridges a Node file stream into the DOM-typed ReadableStream hono's
// body() accepts. Readable.toWeb()'s node-typed result is structurally
// incompatible with the DOM ReadableStream, so the stream is pumped
// manually with pause/resume backpressure, as node-server itself does.
const streamBody = (stream: ReadStream): ReadableStream<Uint8Array> => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let settled = false;

  const cleanup = (): void => {
    stream.off("data", onData);
    stream.off("error", onError);
    stream.off("end", onTerminate);
    stream.off("close", onTerminate);
  };

  const settle = (finish?: () => void): void => {
    if (settled) return;
    settled = true;
    cleanup();
    finish?.();
  };

  const onData = (chunk: Buffer): void => {
    if (settled || controller === undefined) return;
    // createReadStream runs without encoding, so chunks are Buffers.
    controller.enqueue(chunk);
    if ((controller.desiredSize ?? 0) <= 0) stream.pause();
  };

  const onError = (error: Error): void => {
    settle(() => {
      controller?.error(error);
    });
  };

  const onTerminate = (): void => {
    settle(() => {
      controller?.close();
    });
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      stream.on("data", onData);
      stream.on("error", onError);
      stream.on("end", onTerminate);
      stream.on("close", onTerminate);
      stream.pause();
    },
    pull() {
      if (!settled) stream.resume();
    },
    cancel() {
      settle();
      // Suppress a late `error` emitted between destroy() and `close`.
      const ignoreError = (): void => undefined;
      stream.on("error", ignoreError);
      stream.once("close", () => stream.off("error", ignoreError));
      stream.destroy();
    },
  });
};

type ByteRangeSpec =
  | { type: "bounded"; start: number; end: number }
  | { type: "open-ended"; start: number }
  | { type: "suffix"; length: number };

type ByteRange = { start: number; end: number };

// One range like "bytes=4-11", "bytes=4-", "bytes=-8"; the "bytes=" prefix
// and an empty (absent) value are tolerated the way serveStatic always did.
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
  const { start, end } = resolved;
  c.header("Content-Length", (end - start + 1).toString());
  c.header("Content-Range", `bytes ${start}-${end}/${size}`);
  return c.body(streamBody(createReadStream(path, { start, end })), 206);
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
  return c.body(streamBody(createReadStream(path)), 200);
};

// Sends the file at an already-validated absolute path. The caller owns the
// safety checks (containment, dotfile and symlink rules — see browse.tsx) and
// passes the stats it validated against, so the file is never re-resolved.
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
