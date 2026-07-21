import { type Hono } from "hono";
import type { ServerContext } from "../context.js";
import { serveAsset } from "../http.js";

const contentTypeFor = (path: string): string =>
  path.endsWith(".css")
    ? "text/css; charset=utf-8"
    : "application/javascript; charset=utf-8";

const registerAssetRoutes = (app: Hono, ctx: ServerContext): void => {
  const a = ctx.assets;
  const routes = [
    { path: "/assets/htmx.min.js", body: a.htmx },
    { path: "/assets/app.css", body: a.appCss },
    { path: "/assets/sidebar.js", body: a.sidebar },
    { path: "/assets/stream.js", body: a.stream },
    { path: "/assets/rename.js", body: a.rename },
    { path: "/assets/source-picker.js", body: a.sourcePicker },
    { path: "/assets/ui.js", body: a.ui },
    { path: "/assets/prompts.js", body: a.prompts },
    { path: "/assets/passkey.js", body: a.passkey },
  ];
  for (const { path, body } of routes)
    app.get(path, (c) => serveAsset(c, body, contentTypeFor(path)));
};

export { registerAssetRoutes };
