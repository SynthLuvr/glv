import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AuthService,
  RpConfig,
  VerifyResult,
} from "../../auth/service.js";
import { resolveRequestUrl } from "../../auth/service.js";
import { errorMessage } from "../../util.js";
import {
  DevicesPage,
  EnrollPage,
  LoginPage,
  RegisterPage,
} from "../../views/Auth.js";
import type { ServerContext } from "../context.js";
import { param, sendHtml } from "../http.js";

const rpFromRequest = (req: FastifyRequest, ctx: ServerContext): RpConfig => {
  const url = resolveRequestUrl(req);
  return {
    rpName: ctx.rpName ?? "GLV",
    rpID: ctx.rpIdOverride ?? (url.hostname || "localhost"),
    expectedOrigin: url.origin,
  };
};

const finishAuth = (
  reply: FastifyReply,
  auth: AuthService,
  result: VerifyResult,
  fallbackError: string,
): FastifyReply => {
  if (result.verified && result.token !== undefined) {
    auth.setSessionCookie(reply, result.token);
    return reply.send({ verified: true });
  }
  return reply
    .code(400)
    .send({ verified: false, error: result.error ?? fallbackError });
};

// Route failures become structured JSON instead of an opaque 500: malformed
// verify bodies are client input (400), while option generation is server-side
// (500).
const jsonOrError = async <T,>(
  reply: FastifyReply,
  run: () => Promise<T>,
): Promise<FastifyReply> => {
  let payload: T;
  try {
    payload = await run();
  } catch (err) {
    return reply.code(500).send({ error: errorMessage(err) });
  }
  return reply.send(payload);
};

const verifyAndRespond = async (
  reply: FastifyReply,
  auth: AuthService,
  fallbackError: string,
  verify: () => Promise<VerifyResult>,
): Promise<FastifyReply> => {
  let result: VerifyResult;
  try {
    result = await verify();
  } catch (err) {
    return reply.code(400).send({ verified: false, error: errorMessage(err) });
  }
  return finishAuth(reply, auth, result, fallbackError);
};

const registerAuthRoutes = (app: FastifyInstance, ctx: ServerContext): void => {
  const auth = ctx.auth;
  if (auth === undefined) return;

  app.get("/auth/register", (_req, reply) => {
    if (auth.isClaimed()) return reply.redirect("/auth/login", 302);
    return sendHtml(reply, <RegisterPage agentName={ctx.profile.agentName} />);
  });

  app.get("/auth/login", (_req, reply) => {
    if (!auth.isClaimed()) return reply.redirect("/auth/register", 302);
    return sendHtml(reply, <LoginPage agentName={ctx.profile.agentName} />);
  });

  app.get("/auth/register/options", async (req, reply) => {
    if (auth.isClaimed())
      return reply.code(403).send({ error: "Registration is closed." });
    return jsonOrError(reply, () =>
      auth.registrationOptions(rpFromRequest(req, ctx)),
    );
  });

  app.post("/auth/register/verify", async (req, reply) => {
    if (auth.isClaimed())
      return reply
        .code(403)
        .send({ verified: false, error: "Registration is closed." });
    return verifyAndRespond(reply, auth, "Verification failed.", async () =>
      auth.verifyRegistration(
        rpFromRequest(req, ctx),
        req.body as Parameters<typeof auth.verifyRegistration>[1],
      ),
    );
  });

  app.get("/auth/login/options", async (req, reply) =>
    jsonOrError(reply, () => auth.loginOptions(rpFromRequest(req, ctx))),
  );

  app.post("/auth/login/verify", (req, reply) =>
    verifyAndRespond(reply, auth, "Login failed.", async () =>
      auth.verifyLogin(
        rpFromRequest(req, ctx),
        req.body as Parameters<typeof auth.verifyLogin>[1],
      ),
    ),
  );

  // Owner-only passkey management. The auth gate hooks these (they are
  // excluded from isPublicPath), so reaching a handler implies a valid
  // session.
  app.get("/auth/devices", (_req, reply) =>
    sendHtml(
      reply,
      <DevicesPage
        credentials={auth.listCredentialSummaries()}
        agentName={ctx.profile.agentName}
      />,
    ),
  );

  app.post("/auth/devices", (req, reply) => {
    const token = auth.issueEnrollmentToken();
    const enrollUrl =
      token === undefined
        ? undefined
        : `${resolveRequestUrl(req).origin}/auth/enroll/${token}`;
    return sendHtml(
      reply,
      <DevicesPage
        agentName={ctx.profile.agentName}
        credentials={auth.listCredentialSummaries()}
        enrollUrl={enrollUrl}
        token={token}
      />,
    );
  });

  // Token-gated enrollment: the owner redeems a link on a different origin to
  // add a passkey bound to that origin's RP ID. Stays public (no session) but
  // every step re-checks the bearer token.
  app.get("/auth/enroll/:token", (req, reply) => {
    const token = param(req, "token");
    if (!auth.isEnrollmentTokenValid(token))
      return reply.redirect("/auth/login", 302);
    return sendHtml(
      reply,
      <EnrollPage token={token} agentName={ctx.profile.agentName} />,
    );
  });

  app.get("/auth/enroll/:token/options", async (req, reply) => {
    const token = param(req, "token");
    if (!auth.isEnrollmentTokenValid(token))
      return reply
        .code(403)
        .send({ error: "Enrollment link expired or already used." });
    return jsonOrError(reply, () =>
      auth.registrationOptions(rpFromRequest(req, ctx)),
    );
  });

  app.post("/auth/enroll/:token/verify", async (req, reply) => {
    const token = param(req, "token");
    if (!auth.isEnrollmentTokenValid(token))
      return reply.code(400).send({
        verified: false,
        error: "Enrollment link expired or already used.",
      });
    return verifyAndRespond(reply, auth, "Enrollment failed.", async () => {
      const result = await auth.verifyEnrollment(
        rpFromRequest(req, ctx),
        req.body as Parameters<typeof auth.verifyEnrollment>[1],
      );
      // Burn the link only after a successful enroll so a cancelled or failed
      // ceremony can be retried with the same link.
      if (result.verified) auth.consumeEnrollmentToken(token);
      return result;
    });
  });

  app.post("/auth/logout", (req, reply) => {
    auth.logout(req, reply);
    return reply.redirect("/auth/login", 302);
  });
};

export { registerAuthRoutes };
