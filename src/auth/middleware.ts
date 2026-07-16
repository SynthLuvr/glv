import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthService } from "./service.js";

const COOKIE_NAME = "glv_session";

// Every static asset is served under a single prefix so the auth gate can
// whitelist them as a group without naming each file individually.
const ASSET_PREFIX = "/assets/";

const isPublicPath = (path: string): boolean =>
  path === "/auth" ||
  path.startsWith("/auth/") ||
  path.startsWith(ASSET_PREFIX);

const authMiddleware =
  (auth: AuthService): MiddlewareHandler =>
  async (c, next) => {
    if (isPublicPath(c.req.path)) return next();
    if (auth.isValidSession(getCookie(c, COOKIE_NAME))) return next();
    const dest = auth.isClaimed() ? "/auth/login" : "/auth/register";
    return c.redirect(dest, 302);
  };

export { authMiddleware, COOKIE_NAME };
