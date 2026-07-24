import { type Context, type Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import type { RpConfig, VerifyResult } from "../../auth/service.js";
import {
  COOKIE_NAME,
  resolveRequestUrl,
  setSessionCookie,
} from "../../auth/service.js";
import {
  DevicesPage,
  EnrollPage,
  LoginPage,
  RegisterPage,
} from "../../views/Auth.js";
import type { ServerContext } from "../context.js";
import { errorMessage } from "../http.js";

const rpFromContext = (c: Context, ctx: ServerContext): RpConfig => {
  const url = resolveRequestUrl(c);
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

const registerAuthRoutes = (app: Hono, ctx: ServerContext): void => {
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

  app.get("/auth/login/options", async (c) =>
    jsonOrError(c, () => auth.loginOptions(rpFromContext(c, ctx))),
  );

  app.post("/auth/login/verify", (c) =>
    verifyAndRespond(c, "Login failed.", async () =>
      auth.verifyLogin(rpFromContext(c, ctx), await c.req.json()),
    ),
  );

  // Owner-only passkey management. The auth middleware gates these (they are
  // excluded from isPublicPath), so reaching a handler implies a valid session.
  app.get("/auth/devices", (c) =>
    c.html(<DevicesPage credentials={auth.listCredentialSummaries()} />),
  );

  app.post("/auth/devices", (c) => {
    const token = auth.issueEnrollmentToken();
    const enrollUrl =
      token === undefined
        ? undefined
        : `${resolveRequestUrl(c).origin}/auth/enroll/${token}`;
    return c.html(
      <DevicesPage
        credentials={auth.listCredentialSummaries()}
        enrollUrl={enrollUrl}
        token={token}
      />,
    );
  });

  // Token-gated enrollment: the owner redeems a link on a different origin to
  // add a passkey bound to that origin's RP ID. Stays public (no session) but
  // every step re-checks the bearer token.
  app.get("/auth/enroll/:token", (c) => {
    const token = c.req.param("token");
    if (!auth.isEnrollmentTokenValid(token))
      return c.redirect("/auth/login", 302);
    return c.html(<EnrollPage token={token} />);
  });

  app.get("/auth/enroll/:token/options", async (c) => {
    const token = c.req.param("token");
    if (!auth.isEnrollmentTokenValid(token))
      return c.json({ error: "Enrollment link expired or already used." }, 403);
    return jsonOrError(c, () =>
      auth.registrationOptions(rpFromContext(c, ctx)),
    );
  });

  app.post("/auth/enroll/:token/verify", async (c) => {
    const token = c.req.param("token");
    if (!auth.isEnrollmentTokenValid(token))
      return c.json(
        { verified: false, error: "Enrollment link expired or already used." },
        400,
      );
    return verifyAndRespond(c, "Enrollment failed.", async () => {
      const result = await auth.verifyEnrollment(
        rpFromContext(c, ctx),
        await c.req.json(),
      );
      // Burn the link only after a successful enroll so a cancelled or failed
      // ceremony can be retried with the same link.
      if (result.verified) auth.consumeEnrollmentToken(token);
      return result;
    });
  });

  app.post("/auth/logout", (c) => {
    auth.logout(getCookie(c, COOKIE_NAME));
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.redirect("/auth/login", 302);
  });
};

export { registerAuthRoutes };
