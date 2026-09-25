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
import { sendHtml } from "../http.js";
import { parseAuthentication, parseRegistration } from "../webauthn-json.js";

const rpFromRequest = (
  request: FastifyRequest,
  ctx: ServerContext,
): RpConfig => {
  const url = resolveRequestUrl(request);
  return {
    rpName: ctx.rpName ?? "GLV",
    rpID: ctx.rpIdOverride ?? (url.hostname || "localhost"),
    expectedOrigin: url.origin,
  };
};

const finishAuth = (
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
  result: VerifyResult,
  fallbackError: string,
): FastifyReply => {
  if (result.verified && result.token !== undefined) {
    auth.setSessionCookie(request, reply, result.token);
    return reply.send({ verified: true });
  }
  return reply
    .status(400)
    .send({ verified: false, error: result.error ?? fallbackError });
};

// Route failures become structured JSON instead of an opaque 500: malformed
// verify bodies are client input (400), while option generation is server-side
// (500).
const jsonOrError = async <T,>(
  reply: FastifyReply,
  run: () => Promise<T>,
): Promise<FastifyReply> => {
  try {
    const payload = await run();
    return await reply.send(payload);
  } catch (err) {
    return reply.status(500).send({ error: errorMessage(err) });
  }
};

const verifyAndRespond = async (
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
  fallbackError: string,
  verify: () => Promise<VerifyResult>,
): Promise<FastifyReply> => {
  try {
    const result = await verify();
    return await finishAuth(request, reply, auth, result, fallbackError);
  } catch (err) {
    return reply
      .status(400)
      .send({ verified: false, error: errorMessage(err) });
  }
};

// A body the structural guards in webauthn-json.ts reject is a client
// error, reported like a failed ceremony.
const malformedBody = (reply: FastifyReply): FastifyReply =>
  reply.status(400).send({ verified: false, error: "Malformed request." });

const registerAuthRoutes = (app: FastifyInstance, ctx: ServerContext): void => {
  const auth = ctx.auth;
  if (auth === undefined) return;

  app.get("/auth/register", (_request, reply) => {
    if (auth.isClaimed()) return reply.redirect("/auth/login");
    return sendHtml(reply, <RegisterPage agentName={ctx.agentNames} />);
  });

  app.get("/auth/login", (_request, reply) => {
    if (!auth.isClaimed()) return reply.redirect("/auth/register");
    return sendHtml(reply, <LoginPage agentName={ctx.agentNames} />);
  });

  app.get("/auth/register/options", async (request, reply) => {
    if (auth.isClaimed())
      return reply.status(403).send({ error: "Registration is closed." });
    return jsonOrError(reply, () =>
      auth.registrationOptions(rpFromRequest(request, ctx)),
    );
  });

  app.post("/auth/register/verify", async (request, reply) => {
    if (auth.isClaimed())
      return reply
        .status(403)
        .send({ verified: false, error: "Registration is closed." });
    const body = parseRegistration(request.body);
    if (body === undefined) return malformedBody(reply);
    return verifyAndRespond(
      request,
      reply,
      auth,
      "Verification failed.",
      async () => auth.verifyRegistration(rpFromRequest(request, ctx), body),
    );
  });

  app.get("/auth/login/options", async (request, reply) =>
    jsonOrError(reply, () => auth.loginOptions(rpFromRequest(request, ctx))),
  );

  app.post("/auth/login/verify", async (request, reply) => {
    const body = parseAuthentication(request.body);
    if (body === undefined) return malformedBody(reply);
    return verifyAndRespond(request, reply, auth, "Login failed.", async () =>
      auth.verifyLogin(rpFromRequest(request, ctx), body),
    );
  });

  // Owner-only passkey management. The auth middleware gates these (they are
  // excluded from isPublicPath), so reaching a handler implies a valid session.
  app.get("/auth/devices", (_request, reply) =>
    sendHtml(
      reply,
      <DevicesPage
        credentials={auth.listCredentialSummaries()}
        agentName={ctx.agentNames}
      />,
    ),
  );

  app.post("/auth/devices", (request, reply) => {
    const token = auth.issueEnrollmentToken();
    const enrollUrl =
      token === undefined
        ? undefined
        : `${resolveRequestUrl(request).origin}/auth/enroll/${token}`;
    return sendHtml(
      reply,
      <DevicesPage
        agentName={ctx.agentNames}
        credentials={auth.listCredentialSummaries()}
        enrollUrl={enrollUrl}
        token={token}
      />,
    );
  });

  // Token-gated enrollment: the owner redeems a link on a different origin to
  // add a passkey bound to that origin's RP ID. Stays public (no session) but
  // every step re-checks the bearer token.
  app.get<{ Params: { token: string } }>(
    "/auth/enroll/:token",
    (request, reply) => {
      const token = request.params.token;
      if (!auth.isEnrollmentTokenValid(token))
        return reply.redirect("/auth/login");
      return sendHtml(
        reply,
        <EnrollPage token={token} agentName={ctx.agentNames} />,
      );
    },
  );

  app.get<{ Params: { token: string } }>(
    "/auth/enroll/:token/options",
    async (request, reply) => {
      const token = request.params.token;
      if (!auth.isEnrollmentTokenValid(token))
        return reply
          .status(403)
          .send({ error: "Enrollment link expired or already used." });
      return jsonOrError(reply, () =>
        auth.registrationOptions(rpFromRequest(request, ctx)),
      );
    },
  );

  app.post<{ Params: { token: string } }>(
    "/auth/enroll/:token/verify",
    async (request, reply) => {
      const token = request.params.token;
      if (!auth.isEnrollmentTokenValid(token))
        return reply.status(400).send({
          verified: false,
          error: "Enrollment link expired or already used.",
        });
      const body = parseRegistration(request.body);
      if (body === undefined) return malformedBody(reply);
      return verifyAndRespond(
        request,
        reply,
        auth,
        "Enrollment failed.",
        async () => {
          const result = await auth.verifyEnrollment(
            rpFromRequest(request, ctx),
            body,
          );
          // Burn the link only after a successful enroll so a cancelled or failed
          // ceremony can be retried with the same link.
          if (result.verified) auth.consumeEnrollmentToken(token);
          return result;
        },
      );
    },
  );

  app.post("/auth/logout", (request, reply) => {
    auth.logout(request, reply);
    return reply.redirect("/auth/login");
  });
};

export { registerAuthRoutes };
