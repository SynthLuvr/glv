import { type } from "arktype";
import type { FastifyInstance, FastifyReply } from "fastify";
import { API_TOKEN_NAME_ERROR, ApiTokenName } from "../../auth/db.js";
import type { AuthService } from "../../auth/service.js";
import { TokensPage } from "../../views/Auth.js";
import type { ServerContext } from "../context.js";
import { fieldString, parseForm } from "../forms.js";
import { sendHtml } from "../http.js";

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

// Owner-only management, behind the session gate (excluded from
// isPublicPath). The create response re-renders the page showing the raw
// token exactly once — only its hash is stored.
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
        error: API_TOKEN_NAME_ERROR,
      });
    const token = auth.createApiToken(name);
    if (token === undefined)
      return renderTokensPage(reply, auth, ctx, {
        tokenName: name,
        error: "This app has no owner yet.",
      });
    return renderTokensPage(reply, auth, ctx, { token, tokenName: name });
  });

  // Revoking by the stored hash id. Unknown ids revoke nothing and land
  // back on the list — the visible outcome is identical, and there is
  // nothing to leak in a 404.
  app.post<{ Params: { id: string } }>(
    "/auth/tokens/:id/revoke",
    (request, reply) => {
      auth.revokeApiToken(request.params.id);
      return renderTokensPage(reply, auth, ctx);
    },
  );
};

export { registerTokenRoutes };
