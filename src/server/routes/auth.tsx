import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { parse, serialize } from "cookie";
import { type Elysia } from "elysia";
import type { RpConfig, VerifyResult } from "../../auth/service.js";
import {
  COOKIE_NAME,
  resolveRequestUrl,
  setSessionCookie,
} from "../../auth/service.js";
import { errorMessage } from "../../util.js";
import {
  DevicesPage,
  EnrollPage,
  LoginPage,
  RegisterPage,
} from "../../views/Auth.js";
import type { ServerContext } from "../context.js";
import { html, json, type LooseContext, redirect } from "../http.js";

const rpFromContext = (c: LooseContext, ctx: ServerContext): RpConfig => {
  const url = resolveRequestUrl(c);
  return {
    rpName: ctx.rpName ?? "GLV",
    rpID: ctx.rpIdOverride ?? (url.hostname || "localhost"),
    expectedOrigin: url.origin,
  };
};

const finishAuth = (
  c: LooseContext,
  result: VerifyResult,
  fallbackError: string,
) => {
  if (result.verified && result.token !== undefined) {
    setSessionCookie(c, result.token);
    return json(c, { verified: true });
  }
  return json(
    c,
    { verified: false, error: result.error ?? fallbackError },
    400,
  );
};

// Route failures become structured JSON instead of an opaque 500: malformed
// verify bodies are client input (400), while option generation is server-side
// (500).
const jsonOrError = async <T,>(c: LooseContext, run: () => Promise<T>) => {
  try {
    return json(c, await run());
  } catch (err) {
    return json(c, { error: errorMessage(err) }, 500);
  }
};

const verifyAndRespond = async (
  c: LooseContext,
  fallbackError: string,
  verify: () => Promise<VerifyResult>,
) => {
  try {
    return finishAuth(c, await verify(), fallbackError);
  } catch (err) {
    return json(c, { verified: false, error: errorMessage(err) }, 400);
  }
};

const registerAuthRoutes = (app: Elysia, ctx: ServerContext): void => {
  const auth = ctx.auth;
  if (auth === undefined) return;

  app.get("/auth/register", (c) => {
    if (auth.isClaimed()) return redirect(c, "/auth/login", 302);
    return html(c, <RegisterPage />);
  });

  app.get("/auth/login", (c) => {
    if (!auth.isClaimed()) return redirect(c, "/auth/register", 302);
    return html(c, <LoginPage />);
  });

  app.get("/auth/register/options", async (c) => {
    if (auth.isClaimed())
      return json(c, { error: "Registration is closed." }, 403);
    return jsonOrError(c, () =>
      auth.registrationOptions(rpFromContext(c, ctx)),
    );
  });

  app.post("/auth/register/verify", async (c) => {
    if (auth.isClaimed())
      return json(
        c,
        { verified: false, error: "Registration is closed." },
        403,
      );
    return verifyAndRespond(c, "Verification failed.", async () =>
      auth.verifyRegistration(
        rpFromContext(c, ctx),
        c.body as RegistrationResponseJSON,
      ),
    );
  });

  app.get("/auth/login/options", async (c) =>
    jsonOrError(c, () => auth.loginOptions(rpFromContext(c, ctx))),
  );

  app.post("/auth/login/verify", (c) =>
    verifyAndRespond(c, "Login failed.", async () =>
      auth.verifyLogin(
        rpFromContext(c, ctx),
        c.body as AuthenticationResponseJSON,
      ),
    ),
  );

  // Owner-only passkey management. The auth middleware gates these (they are
  // excluded from isPublicPath), so reaching a handler implies a valid session.
  app.get("/auth/devices", (c) =>
    html(c, <DevicesPage credentials={auth.listCredentialSummaries()} />),
  );

  app.post("/auth/devices", (c) => {
    const token = auth.issueEnrollmentToken();
    const enrollUrl =
      token === undefined
        ? undefined
        : `${resolveRequestUrl(c).origin}/auth/enroll/${token}`;
    return html(
      c,
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
    const token = c.params.token;
    if (!auth.isEnrollmentTokenValid(token))
      return redirect(c, "/auth/login", 302);
    return html(c, <EnrollPage token={token} />);
  });

  app.get("/auth/enroll/:token/options", async (c) => {
    const token = c.params.token;
    if (!auth.isEnrollmentTokenValid(token))
      return json(
        c,
        { error: "Enrollment link expired or already used." },
        403,
      );
    return jsonOrError(c, () =>
      auth.registrationOptions(rpFromContext(c, ctx)),
    );
  });

  app.post("/auth/enroll/:token/verify", async (c) => {
    const token = c.params.token;
    if (!auth.isEnrollmentTokenValid(token))
      return json(
        c,
        { verified: false, error: "Enrollment link expired or already used." },
        400,
      );
    return verifyAndRespond(c, "Enrollment failed.", async () => {
      const result = await auth.verifyEnrollment(
        rpFromContext(c, ctx),
        c.body as RegistrationResponseJSON,
      );
      // Burn the link only after a successful enroll so a cancelled or failed
      // ceremony can be retried with the same link.
      if (result.verified) auth.consumeEnrollmentToken(token);
      return result;
    });
  });

  app.post("/auth/logout", (c) => {
    auth.logout(parse(c.request.headers.get("cookie") ?? "")[COOKIE_NAME]);
    c.set.headers["set-cookie"] = serialize(COOKIE_NAME, "", {
      path: "/",
      expires: new Date(0),
      maxAge: 0,
    });
    return redirect(c, "/auth/login", 302);
  });
};

export { registerAuthRoutes };
