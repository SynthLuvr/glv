import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname } from "node:path";
import { type Elysia } from "elysia";
import { mime } from "elysia/universal/file";
import { listSessions } from "../../db.js";
import { BrowseDetail, BrowseError } from "../../views/Browse.js";
import { listBrowseDir, resolveBrowsePath, subPathOf } from "../browse.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { type LooseContext, notFound, send } from "../http.js";
import { render } from "../render.js";

const BROWSE_PREFIX = "/browse";
const FILES_PREFIX = "/files";

// Elysia ships a built-in extension→MIME map (`elysia/universal/file`), but it
// omits markdown and never declares `charset=utf-8` on text types — without that
// charset browsers can mis-decode UTF-8. Only those deltas are restated here;
// every other extension resolves from the built-in table, falling back to a
// generic binary type so browsers at least offer a download.
const MIME: Record<string, string> = {
  ...mime,
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

// The built-in table keys extensions without the leading dot, so strip it.
const contentTypeFor = (rel: string): string =>
  MIME[extname(rel).toLowerCase().slice(1)] ?? "application/octet-stream";

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
