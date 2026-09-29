import type { FastifyInstance } from "fastify";
import { parseMessage } from "../../format/index.js";
import { openApiDocument, parseListQuery } from "../api-schema.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { parseForm } from "../forms.js";
import type { SessionOperations } from "../operations.js";

// The JSON surface for non-browser clients (curl, CI), reached with an
// API-token bearer header — the only credential the write endpoints
// accept — or a session cookie for the reads. Reads delegate to the same
// store queries the HTML handlers use; writes delegate to the same
// operation layer, so the API and the browser UI run identical effects.
// The auth gate answers 401 JSON — never the HTML login redirect — for
// /api/* paths.
const registerApiRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
  ops: SessionOperations,
): void => {
  app.get("/api/sessions", (request, reply) => {
    const query = parseListQuery(request, VIEWER_FILTER.limit);
    if (!query.ok) return reply.status(422).send({ error: query.error });
    return reply.send(
      ctx.sessions.listSessions({
        ...VIEWER_FILTER,
        limit: query.limit,
        offset: query.offset,
      }),
    );
  });

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

  // Returns once the session id exists — not when the run completes;
  // consumers poll the detail endpoint or ride the SSE feed.
  app.post("/api/sessions", async (request, reply) => {
    const body = await parseForm(request);
    const result = await ops.startSession(body);
    if (!result.ok)
      return reply.status(result.status).send({ error: result.error });
    reply.header("Location", `/api/sessions/${result.sessionId}`);
    return reply
      .status(201)
      .send({ id: result.sessionId, status: result.runStatus });
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/prompt",
    async (request, reply) => {
      const body = await parseForm(request);
      const result = await ops.queueFollowUp(request.params.id, body);
      if (!result.ok)
        return reply.status(result.status).send({ error: result.error });
      return reply.send({ id: result.sessionId, status: result.runStatus });
    },
  );

  // Idempotent: 200 whether or not a run is active.
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/stop",
    (request, reply) => {
      const result = ops.stopSession(request.params.id);
      if (!result.ok)
        return reply.status(result.status).send({ error: result.error });
      return reply.send({ id: result.sessionId, status: "stopped" });
    },
  );

  // The machine-readable contract, generated from the same ArkType
  // schemas the routes validate with. Behind auth like every other /api
  // path — the document names no secrets, but this is a single-owner
  // app and the gate is uniform.
  app.get("/api/openapi.json", (_request, reply) =>
    reply.send(openApiDocument(VIEWER_FILTER.limit, 500)),
  );
};

export { registerApiRoutes };
