import { type Hono } from "hono";
import type { ServerContext } from "../context.js";
import { serveAsset } from "../util.js";

const JS_TYPE = "application/javascript; charset=utf-8";

const registerAssetRoutes = (app: Hono, ctx: ServerContext): void => {
  const a = ctx.assets;
  const routes: { path: string; body: string; contentType: string }[] = [
    { path: "/assets/htmx.min.js", body: a.htmx, contentType: JS_TYPE },
    {
      path: "/assets/app.css",
      body: a.appCss,
      contentType: "text/css; charset=utf-8",
    },
    { path: "/assets/sidebar.js", body: a.sidebar, contentType: JS_TYPE },
    { path: "/assets/stream.js", body: a.stream, contentType: JS_TYPE },
    { path: "/assets/theme.js", body: a.theme, contentType: JS_TYPE },
    {
      path: "/assets/markdown-copy.js",
      body: a.markdownCopy,
      contentType: JS_TYPE,
    },
    { path: "/assets/rename.js", body: a.rename, contentType: JS_TYPE },
    {
      path: "/assets/source-picker.js",
      body: a.sourcePicker,
      contentType: JS_TYPE,
    },
    { path: "/assets/ui.js", body: a.ui, contentType: JS_TYPE },
    { path: "/assets/prompts.js", body: a.prompts, contentType: JS_TYPE },
    { path: "/assets/passkey.js", body: a.passkey, contentType: JS_TYPE },
  ];
  for (const { path, body, contentType } of routes)
    app.get(path, (c) => serveAsset(c, body, contentType));
};

export { registerAssetRoutes };
