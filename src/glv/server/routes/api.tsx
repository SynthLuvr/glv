import type { FastifyInstance } from "fastify";
import { parseMessage } from "../../format/index.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";

// Read-only JSON surface for non-browser clients (curl, CI), reached with
// an API-token bearer header (or a session cookie, like every other
// route). It delegates to the same store reads the HTML handlers use —
// listSessions(VIEWER_FILTER) is the sidebar's read, and the detail route
// pairs the session row with the same parsed messages the transcript
// renders. Errors are JSON in their own shape; the auth gate answers 401
// JSON (never the HTML login redirect) for /api/* paths.
const registerApiRoutes = (app: FastifyInstance, ctx: ServerContext): void => {
  app.get("/api/sessions", (_request, reply) =>
    reply.send(ctx.sessions.listSessions(VIEWER_FILTER)),
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id", (request, reply) => {
    const id = request.params.id;
    const session = ctx.sessions.getSession(id);
    if (session === undefined)
      return reply.status(404).send({ error: `No session ${id}.` });
    return reply.send({
      session,
      messages: ctx.sessions.listMessages(id).map(parseMessage),
    });
  });
};

export { registerApiRoutes };
