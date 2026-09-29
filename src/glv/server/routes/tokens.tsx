import { type } from "arktype";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthService } from "../../auth/service.js";
import { TokensPage } from "../../views/Auth.js";
import type { ServerContext } from "../context.js";
import { fieldString, parseForm } from "../forms.js";
import { sendHtml } from "../http.js";

// 1–64 characters once trimmed: the name is a label shown on this screen,
// not an identifier (the stored hash is).
const ApiTokenName = type("string.trim").pipe(type("1<=string<=64"));

const NAME_ERROR = "A token name of 1–64 characters is required.";

const renderTokensPage = (
  reply: FastifyReply,
  auth: AuthService,
  ctx: ServerContext,
  extra: {
    token?: string;
    tokenName?: string;
    error?: string;
  } = {},
): FastifyReply =>
  sendHtml(
    reply,
    <TokensPage
      agentName={ctx.agentNames}
      tokens={auth.listApiTokenSummaries()}
      {...extra}
    />,
  );

// Owner-only API-token management, behind the session gate (excluded from
// isPublicPath). The create response is a full page render showing the raw
// token exactly once — the same shape as the passkey-enrollment flow —
// because only a hash is stored.
const registerTokenRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  const auth = ctx.auth;
  if (auth === undefined) return;

  app.get("/auth/tokens", (_request, reply) =>
    renderTokensPage(reply, auth, ctx),
  );

  app.post("/auth/tokens", async (request, reply) => {
    const body = await parseForm(request);
    const rawName = fieldString(body, "name");
    const name = ApiTokenName(rawName);
    if (name instanceof type.errors)
      return renderTokensPage(reply, auth, ctx, {
        tokenName: rawName,
        error: NAME_ERROR,
      });
    const token = auth.createApiToken(name);
    if (token === undefined)
      return renderTokensPage(reply, auth, ctx, {
        tokenName: name,
        error: "This app has no owner yet.",
      });
    return renderTokensPage(reply, auth, ctx, { token, tokenName: name });
  });

  // Revoking by the stored hash id (the only spelling the page knows).
  // Unknown ids revoke nothing and land back on the list — the outcome the
  // owner sees is identical, and there is nothing to leak in a 404.
  app.post<{ Params: { id: string } }>(
    "/auth/tokens/:id/revoke",
    (request, reply) => {
      auth.revokeApiToken(request.params.id);
      return renderTokensPage(reply, auth, ctx);
    },
  );
};

export { registerTokenRoutes };
