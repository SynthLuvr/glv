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

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Route failures become structured JSON instead of an opaque 500: malformed
// verify bodies are client input (400), while option generation is server-side
// (500).
const jsonOrError = async <T,>(c: Context, run: () => Promise<T>) => {
  try {
    return c.json(await run());
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 500);
  }
};

const verifyAndRespond = async (
  c: Context,
  fallbackError: string,
  verify: () => Promise<VerifyResult>,
) => {
  try {
    return finishAuth(c, await verify(), fallbackError);
  } catch (err) {
    return c.json({ verified: false, error: errorMessage(err) }, 400);
  }
};

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
    return jsonOrError(c, () =>
      auth.registrationOptions(rpFromContext(c, ctx)),
    );
  });

  app.post("/auth/register/verify", async (c) => {
    if (auth.isClaimed())
      return c.json({ verified: false, error: "Registration is closed." }, 403);
    return verifyAndRespond(c, "Verification failed.", async () =>
      auth.verifyRegistration(rpFromContext(c, ctx), await c.req.json()),
    );
  });

  app.get("/auth/login/options", (c) =>
    jsonOrError(c, () => auth.loginOptions(rpFromContext(c, ctx))),
  );

  app.post("/auth/login/verify", (c) =>
    verifyAndRespond(c, "Login failed.", async () =>
      auth.verifyLogin(rpFromContext(c, ctx), await c.req.json()),
    ),
  );

  app.post("/auth/logout", (c) => {
    auth.logout(getCookie(c, COOKIE_NAME));
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.redirect("/auth/login", 302);
  });
};

export { registerAuthRoutes };
