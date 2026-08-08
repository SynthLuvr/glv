import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname } from "node:path";
import { type Elysia } from "elysia";
import { listSessions } from "../../db.js";
import { BrowseDetail, BrowseError } from "../../views/Browse.js";
import { listBrowseDir, resolveBrowsePath, subPathOf } from "../browse.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { type LooseContext, notFound, send } from "../http.js";
import { render } from "../render.js";

const BROWSE_PREFIX = "/browse";
const FILES_PREFIX = "/files";

// A focused MIME table for the file viewer; unknown extensions fall back to a
// generic binary type so browsers at least offer a download.
const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const contentTypeFor = (rel: string): string =>
  MIME[extname(rel).toLowerCase()] ?? "application/octet-stream";

const browseTitle = (rel: string): string =>
  rel === "" ? "Browse ~ — GLV" : `Browse ~/${rel} — GLV`;

const renderBrowse = (
  c: LooseContext,
  ctx: ServerContext,
  sub: string,
): Response => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  const sessions = listSessions(ctx.db, VIEWER_FILTER);
  if (!target.ok)
    return render(
      c,
      ctx,
      sessions,
      undefined,
      <BrowseError status={target.status} />,
      { status: target.status, title: "Browse — GLV" },
    );
  if (!target.stat.isDirectory())
    return render(c, ctx, sessions, undefined, <BrowseError status={404} />, {
      status: 404,
      title: "Browse — GLV",
    });
  const entries = listBrowseDir(target.abs);
  return render(
    c,
    ctx,
    sessions,
    undefined,
    <BrowseDetail rel={target.rel} entries={entries} />,
    { title: browseTitle(target.rel) },
  );
};

// Validates containment, dotfile exclusion, and symlink safety before reading
// the file. Content type comes from the extension map above.
const serveBrowseFile = async (
  c: LooseContext,
  sub: string,
): Promise<Response> => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  if (!target.ok) return send(c, "Not found\n", target.status);
  if (!target.stat.isFile()) return notFound(c);
  const body = await readFile(target.abs);
  return send(c, body, 200, { "content-type": contentTypeFor(target.rel) });
};

// /browse renders a navigable listing; /files streams a file's bytes. Both sit
// behind the passkey auth gate: neither prefix is on the public allowlist.
const registerBrowseRoutes = (app: Elysia, ctx: ServerContext): void => {
  app
    .get(BROWSE_PREFIX, (c) => renderBrowse(c, ctx, ""))
    .get(`${BROWSE_PREFIX}/*`, (c) =>
      renderBrowse(c, ctx, subPathOf(c.path, BROWSE_PREFIX)),
    )
    .get(`${FILES_PREFIX}/*`, (c) =>
      serveBrowseFile(c, subPathOf(c.path, FILES_PREFIX)),
    );
};

export { registerBrowseRoutes };
