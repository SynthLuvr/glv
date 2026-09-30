import type { FastifyInstance, FastifyReply } from "fastify";
import { parseMessage } from "../../format/index.js";
import {
  openApiDocument,
  parseListQuery,
  toApiCronJob,
} from "../api-schema.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import type { CronOperations } from "../cron-operations.js";
import { firstString, parseForm, stringFields } from "../forms.js";
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
  cronOps: CronOperations,
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

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/stop",
    (request, reply) => {
      const result = ops.stopSession(request.params.id);
      if (!result.ok)
        return reply.status(result.status).send({ error: result.error });
      return reply.send({ id: result.sessionId, status: "stopped" });
    },
  );

  // Scheduled runs over JSON: the same cron operation layer the
  // browser's Scheduled runs section delegates to, so a script
  // schedules exactly what the form would save (one-shots, cron, and
  // human-text schedules alike), and every mutation lands in the cron
  // database and applies to the running scheduler immediately.
  const cronReadError = (reply: FastifyReply, error: string) =>
    reply
      .status(500)
      .send({ error: `Could not read the cron database: ${error}` });

  app.get("/api/cron", (_request, reply) => {
    const { jobs, error } = cronOps.listJobs();
    if (error !== undefined) return cronReadError(reply, error);
    return reply.send(
      jobs.map((job) => toApiCronJob(job, ctx.defaultAgent.id)),
    );
  });

  app.get<{ Params: { name: string } }>("/api/cron/:name", (request, reply) => {
    const { jobs, error } = cronOps.listJobs();
    if (error !== undefined) return cronReadError(reply, error);
    const job = jobs.find((entry) => entry.name === request.params.name);
    if (job === undefined)
      return reply
        .status(404)
        .send({ error: `No scheduled run ${request.params.name}.` });
    return reply.send(toApiCronJob(job, ctx.defaultAgent.id));
  });

  app.post("/api/cron", async (request, reply) => {
    const body = await parseForm(request);
    const result = cronOps.createJob({
      name: firstString(body.name),
      schedule: firstString(body.schedule),
      prompt: firstString(body.prompt),
      workingDir: firstString(body.working_dir),
      timezone: firstString(body.timezone),
      model: firstString(body.model),
      followUps: stringFields(body, "follow_ups"),
    });
    if (!result.ok)
      return reply.status(result.status).send({ error: result.error });
    reply.header(
      "Location",
      `/api/cron/${encodeURIComponent(result.job.name)}`,
    );
    return reply
      .status(201)
      .send(toApiCronJob(result.job, ctx.defaultAgent.id));
  });

  app.delete<{ Params: { name: string } }>(
    "/api/cron/:name",
    (request, reply) => {
      const result = cronOps.deleteJob(request.params.name);
      if (!result.ok)
        return reply.status(result.status).send({ error: result.error });
      return reply.send({ name: result.name, status: "deleted" });
    },
  );

  // Behind auth like every other /api path — the document names no
  // secrets, but this is a single-owner app and the gate is uniform.
  app.get("/api/openapi.json", (_request, reply) =>
    reply.send(openApiDocument(VIEWER_FILTER.limit)),
  );
};

export { registerApiRoutes };
