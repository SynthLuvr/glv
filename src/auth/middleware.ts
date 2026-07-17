import { type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { SESSION_TTL_SECONDS } from "./db.js";
import type { AuthService } from "./service.js";

const COOKIE_NAME = "glv_session";

// Every static asset is served under a single prefix so the auth gate can
// whitelist them as a group without naming each file individually.
const ASSET_PREFIX = "/assets/";

const isPublicPath = (path: string): boolean =>
  path === "/auth" ||
  path.startsWith("/auth/") ||
  path.startsWith(ASSET_PREFIX);

const setSessionCookie = (c: Context, token: string): void => {
  const url = new URL(c.req.url);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
};

const authMiddleware =
  (auth: AuthService): MiddlewareHandler =>
  async (c, next) => {
    if (isPublicPath(c.req.path)) return next();
    const token = getCookie(c, COOKIE_NAME);
    if (token !== undefined && auth.isValidSession(token)) {
      // Sliding window: re-issue the cookie so the browser expiry tracks
      // the just-refreshed DB session rather than the original login.
      setSessionCookie(c, token);
      return next();
    }
    const dest = auth.isClaimed() ? "/auth/login" : "/auth/register";
    return c.redirect(dest, 302);
  };

export { authMiddleware, COOKIE_NAME, setSessionCookie };
