import { type Hono } from "hono";
import type { AppEnv, ServerContext } from "../context.js";
import { serveAsset } from "../util.js";

const registerAssetRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  const a = ctx.assets;
  app.get("/assets/htmx.min.js", (c) =>
    serveAsset(c, a.htmx, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/app.css", (c) =>
    serveAsset(c, a.appCss, "text/css; charset=utf-8"),
  );
  app.get("/assets/sidebar.js", (c) =>
    serveAsset(c, a.sidebar, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/stream.js", (c) =>
    serveAsset(c, a.stream, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/theme.js", (c) =>
    serveAsset(c, a.theme, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/markdown-copy.js", (c) =>
    serveAsset(c, a.markdownCopy, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/rename.js", (c) =>
    serveAsset(c, a.rename, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/source-picker.js", (c) =>
    serveAsset(c, a.sourcePicker, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/ui.js", (c) =>
    serveAsset(c, a.ui, "application/javascript; charset=utf-8"),
  );
  app.get("/assets/passkey.js", (c) =>
    serveAsset(c, a.passkey, "application/javascript; charset=utf-8"),
  );
};

export { registerAssetRoutes };
