import { homedir } from "node:os";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, type Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { listSessions } from "../../db.js";
import { BrowseDetail, BrowseError } from "../../views/Browse.js";
import { listBrowseDir, resolveBrowsePath, subPathOf } from "../browse.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { render } from "../render.js";

const BROWSE_PREFIX = "/browse";
const FILES_PREFIX = "/files";

const browseTitle = (rel: string): string =>
  rel === "" ? "Browse ~ — GLV" : `Browse ~/${rel} — GLV`;

// Renders a directory listing in the standard shell (or just the detail
// fragment for an htmx request), or a not-available notice when the path is
// hidden, missing, or outside the home root.
const renderBrowse = (
  c: Context,
  ctx: ServerContext,
  sub: string,
): Response | Promise<Response> => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  if (!target.ok)
    return render(
      c,
      ctx,
      listSessions(ctx.db, VIEWER_FILTER),
      undefined,
      <BrowseError status={target.status} />,
      { status: target.status, title: "Browse — GLV" },
    );
  if (!target.stat.isDirectory())
    return render(
      c,
      ctx,
      listSessions(ctx.db, VIEWER_FILTER),
      undefined,
      <BrowseError status={404} />,
      { status: 404, title: "Browse — GLV" },
    );
  const entries = listBrowseDir(target.abs);
  const segments = target.rel === "" ? [] : target.rel.split("/");
  return render(
    c,
    ctx,
    listSessions(ctx.db, VIEWER_FILTER),
    undefined,
    <BrowseDetail rel={target.rel} segments={segments} entries={entries} />,
    { title: browseTitle(target.rel) },
  );
};

// Delivers a single file's bytes. The path is validated for containment,
// dotfile exclusion, and symlink safety before handing off to Hono's
// serveStatic, which handles content types, byte ranges, and streaming.
const serveBrowseFile = async (c: Context, sub: string): Promise<Response> => {
  const home = homedir();
  const target = resolveBrowsePath(home, sub);
  if (!target.ok)
    return c.body("Not found\n", target.status as ContentfulStatusCode);
  if (!target.stat.isFile()) return c.notFound();
  const result = await serveStatic({
    root: home,
    rewriteRequestPath: () => target.rel,
  })(c, async () => {
    /* file present on validation; serveStatic only falls through on a race */
  });
  return result instanceof Response ? result : c.notFound();
};

// Two distinct concerns, kept separate but linked: /browse renders a
// navigable listing, /files streams a selected file's bytes. Both sit behind
// the passkey auth gate because neither prefix is on the public allowlist.
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
