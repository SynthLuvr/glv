import { createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BrowseDetail, BrowseError } from "../../views/Browse.js";
import { listBrowseDir, resolveBrowsePath, subPathOf } from "../browse.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { pathOf } from "../http.js";
import { render } from "../render.js";

const BROWSE_PREFIX = "/browse";
const FILES_PREFIX = "/files";

const browseTitle = (rel: string): string =>
  rel === "" ? "Browse ~ — GLV" : `Browse ~/${rel} — GLV`;

const renderBrowse = (
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
  sub: string,
): FastifyReply => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  const sessions = ctx.sessions.listSessions(VIEWER_FILTER);
  if (!target.ok)
    return render(
      req,
      reply,
      ctx,
      sessions,
      undefined,
      <BrowseError status={target.status} />,
      { status: target.status, title: "Browse — GLV" },
    );
  if (!target.stat.isDirectory())
    return render(
      req,
      reply,
      ctx,
      sessions,
      undefined,
      <BrowseError status={404} />,
      {
        status: 404,
        title: "Browse — GLV",
      },
    );
  const entries = listBrowseDir(target.abs);
  return render(
    req,
    reply,
    ctx,
    sessions,
    undefined,
    <BrowseDetail rel={target.rel} entries={entries} />,
    { title: browseTitle(target.rel) },
  );
};

// Text and image types carry a charset so browsers render instead of
// download; everything unknown streams as opaque bytes.
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".aac": "audio/aac",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".webm": "video/webm",
};

const contentTypeForFile = (abs: string): string =>
  CONTENT_TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream";

type ByteRange = { start: number; end: number };

// A single "bytes=" range: open-ended (bytes=500-), suffix (bytes=-500),
// or bounded (bytes=500-999). Malformed or unsatisfiable ranges return
// undefined so the caller can answer with the full body or a 416.
const parseByteRange = (
  header: string,
  size: number,
): ByteRange | "unsatisfiable" | "invalid" => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return "invalid";
  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === "") {
    const length = Number(endRaw);
    if (length === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(startRaw);
  if (start >= size) return "unsatisfiable";
  const end = endRaw === "" ? size - 1 : Math.min(Number(endRaw), size - 1);
  if (end < start) return "invalid";
  return { start, end };
};

// Streams the file's bytes with byte-range support (media seeking, partial
// fetches). Containment, dotfile exclusion, and symlink safety were already
// validated by resolveBrowsePath before this runs.
const serveBrowseFile = (
  req: FastifyRequest,
  reply: FastifyReply,
  sub: string,
): FastifyReply => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  if (!target.ok) return reply.code(target.status).send("Not found\n");
  if (!target.stat.isFile()) {
    reply.callNotFound();
    return reply;
  }
  const type = contentTypeForFile(target.abs);
  const size = statSync(target.abs).size;
  const header = req.headers.range;
  const range =
    typeof header === "string" && header !== ""
      ? parseByteRange(header, size)
      : undefined;
  if (range === "unsatisfiable")
    return reply.code(416).header("Content-Range", `bytes */${size}`).send("");
  if (range !== undefined && range !== "invalid")
    return reply
      .code(206)
      .header("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", String(range.end - range.start + 1))
      .type(type)
      .send(
        createReadStream(target.abs, { start: range.start, end: range.end }),
      );
  return reply
    .header("Accept-Ranges", "bytes")
    .header("Content-Length", String(size))
    .type(type)
    .send(createReadStream(target.abs));
};

// /browse renders a navigable listing; /files streams a file's bytes. Both sit
// behind the passkey auth gate: neither prefix is on the public allowlist.
const registerBrowseRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  app.get(BROWSE_PREFIX, (req, reply) => renderBrowse(req, reply, ctx, ""));
  app.get(`${BROWSE_PREFIX}/*`, (req, reply) =>
    renderBrowse(req, reply, ctx, subPathOf(pathOf(req), BROWSE_PREFIX)),
  );
  app.get(`${FILES_PREFIX}/*`, (req, reply) =>
    serveBrowseFile(req, reply, subPathOf(pathOf(req), FILES_PREFIX)),
  );
};

export { registerBrowseRoutes };
