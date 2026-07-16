import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthService } from "./service.js";

const COOKIE_NAME = "glv_session";

const ASSET_PATHS = new Set<string>([
  "/htmx.min.js",
  "/app.css",
  "/sidebar.js",
  "/stream.js",
  "/theme.js",
  "/markdown-copy.js",
  "/rename.js",
  "/passkey.js",
]);

const isPublicPath = (path: string): boolean =>
  path === "/auth" || path.startsWith("/auth/") || ASSET_PATHS.has(path);

// Sits first in the chain: every non-public request must carry a valid
// session or it is redirected to the login (or registration) screen.
const authMiddleware =
  (auth: AuthService): MiddlewareHandler =>
  async (c, next) => {
    if (isPublicPath(c.req.path)) return next();
    if (auth.isValidSession(getCookie(c, COOKIE_NAME))) return next();
    const dest = auth.isClaimed() ? "/auth/login" : "/auth/register";
    return c.redirect(dest, 302);
  };

export { authMiddleware, COOKIE_NAME };
