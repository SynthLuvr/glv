import { homedir } from "node:os";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, type Hono } from "hono";
import {
  listBrowseDir,
  resolveBrowsePath,
  subPathOf,
} from "../../../glv/server/browse.js";
import { BrowseDetail, BrowseError } from "../../../glv/views/Browse.js";
import { listSessions } from "../../db.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { render } from "../render.js";

const BROWSE_PREFIX = "/browse";
const FILES_PREFIX = "/files";

const browseTitle = (rel: string): string =>
  rel === "" ? "Browse ~ — GLV" : `Browse ~/${rel} — GLV`;

const renderBrowse = (
  c: Context,
  ctx: ServerContext,
  sub: string,
): Response | Promise<Response> => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  const sessions = listSessions(ctx.store, VIEWER_FILTER);
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

// Validates containment, dotfile exclusion, and symlink safety before handing
// off to serveStatic, which handles content types, byte ranges, and streaming.
const serveBrowseFile = async (c: Context, sub: string): Promise<Response> => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  if (!target.ok) return c.body("Not found\n", target.status);
  if (!target.stat.isFile()) return c.notFound();
  const result = await serveStatic({
    root: home,
    rewriteRequestPath: () => target.rel,
  })(c, async () => {
    // Validated above; serveStatic only reaches next() on a file race.
  });
  return result instanceof Response ? result : c.notFound();
};

// /browse renders a navigable listing; /files streams a file's bytes. Both sit
// behind the passkey auth gate: neither prefix is on the public allowlist.
const registerBrowseRoutes = (app: Hono, ctx: ServerContext): void => {
  app.get(BROWSE_PREFIX, (c) => renderBrowse(c, ctx, ""));
  app.get(`${BROWSE_PREFIX}/*`, (c) =>
    renderBrowse(c, ctx, subPathOf(c.req.path, BROWSE_PREFIX)),
  );
  app.get(`${FILES_PREFIX}/*`, (c) =>
    serveBrowseFile(c, subPathOf(c.req.path, FILES_PREFIX)),
  );
};

export { registerBrowseRoutes };
