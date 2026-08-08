import { type Elysia } from "elysia";
import type { ServerContext } from "../context.js";
import { serveAsset } from "../http.js";

const contentTypeFor = (path: string): string =>
  path.endsWith(".css")
    ? "text/css; charset=utf-8"
    : "application/javascript; charset=utf-8";

const registerAssetRoutes = (app: Elysia, ctx: ServerContext): Elysia => {
  const a = ctx.assets;
  const routes = [
    { path: "/assets/htmx.min.js", body: a.htmx },
    { path: "/assets/app.css", body: a.appCss },
    { path: "/assets/sidebar.js", body: a.sidebar },
    { path: "/assets/stream.js", body: a.stream },
    { path: "/assets/rename.js", body: a.rename },
    { path: "/assets/ui.js", body: a.ui },
    { path: "/assets/prompts.js", body: a.prompts },
    { path: "/assets/groups.js", body: a.groups },
    { path: "/assets/passkey.js", body: a.passkey },
    { path: "/assets/uploads.js", body: a.uploads },
  ];
  return routes.reduce<Elysia>(
    (acc, { path, body }) =>
      acc.get(path, (c) => serveAsset(c, body, contentTypeFor(path))),
    app,
  );
};

export { registerAssetRoutes };
