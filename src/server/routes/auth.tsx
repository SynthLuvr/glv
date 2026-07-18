import { type Context, type Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { COOKIE_NAME, setSessionCookie } from "../../auth/middleware.js";
import type { RpConfig, VerifyResult } from "../../auth/service.js";
import { LoginPage, RegisterPage } from "../../views/Auth.js";
import type { AppEnv, ServerContext } from "../context.js";

const rpFromContext = (c: Context, ctx: ServerContext): RpConfig => {
  const url = new URL(c.req.url);
  return {
    rpName: ctx.rpName ?? "Goose Log Viewer",
    rpID: ctx.rpIdOverride ?? (url.hostname || "localhost"),
    expectedOrigin: url.origin,
  };
};

const finishAuth = (
  c: Context,
  result: VerifyResult,
  fallbackError: string,
) => {
  if (result.verified && result.token !== undefined) {
    setSessionCookie(c, result.token);
    return c.json({ verified: true });
  }
  return c.json({ verified: false, error: result.error ?? fallbackError }, 400);
};

// Normalises a thrown value into a human-readable message so failures surface
// as structured JSON rather than an opaque 500.
const describeErr = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const registerAuthRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  const auth = ctx.auth;
  if (auth === undefined) return;

  app.get("/auth/register", (c) => {
    if (auth.isClaimed()) return c.redirect("/auth/login", 302);
    return c.html(<RegisterPage />);
  });

  app.get("/auth/login", (c) => {
    if (!auth.isClaimed()) return c.redirect("/auth/register", 302);
    return c.html(<LoginPage />);
  });

  app.get("/auth/register/options", async (c) => {
    if (auth.isClaimed())
      return c.json({ error: "Registration is closed." }, 403);
    try {
      return c.json(await auth.registrationOptions(rpFromContext(c, ctx)));
    } catch (err) {
      return c.json({ error: describeErr(err) }, 500);
    }
  });

  app.post("/auth/register/verify", async (c) => {
    if (auth.isClaimed())
      return c.json({ verified: false, error: "Registration is closed." }, 403);
    try {
      const result = await auth.verifyRegistration(
        rpFromContext(c, ctx),
        await c.req.json(),
      );
      return finishAuth(c, result, "Verification failed.");
    } catch (err) {
      return c.json({ verified: false, error: describeErr(err) }, 400);
    }
  });

  app.get("/auth/login/options", async (c) => {
    try {
      return c.json(await auth.loginOptions(rpFromContext(c, ctx)));
    } catch (err) {
      return c.json({ error: describeErr(err) }, 500);
    }
  });

  app.post("/auth/login/verify", async (c) => {
    try {
      const result = await auth.verifyLogin(
        rpFromContext(c, ctx),
        await c.req.json(),
      );
      return finishAuth(c, result, "Login failed.");
    } catch (err) {
      return c.json({ verified: false, error: describeErr(err) }, 400);
    }
  });

  app.post("/auth/logout", (c) => {
    auth.logout(getCookie(c, COOKIE_NAME));
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.redirect("/auth/login", 302);
  });
};

export { registerAuthRoutes };
