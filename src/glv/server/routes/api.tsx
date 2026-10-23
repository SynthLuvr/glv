import type { FastifyInstance, FastifyReply } from "fastify";
import { parseMessage } from "../../format/index.js";
import { getPrompt, listPrompts } from "../../prompts/db.js";
import {
  type LastRunRecord,
  readLastRun,
  readLastRuns,
} from "../../stop-notices.js";
import {
  openApiDocument,
  parseDetailQuery,
  parseListQuery,
  parseWaitQuery,
  toApiCronJob,
  toApiPrompt,
  toApiSession,
  toApiWaitResult,
} from "../api-schema.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import type { CronOperations } from "../cron-operations.js";
import { firstString, parseForm, stringFields } from "../forms.js";
import type { SessionOperations } from "../operations.js";
import { waitForRunSettle } from "../wait.js";

// The last-run reads behind both session read endpoints. The sidecar is
// optional (app-less tests), and its absence reads as "no verdict
// recorded" — the same guard session.ts applies to notice reads. The
// listing takes every verdict in one query so it can flag badly-ended
// runs without a read per session; the detail read takes the one row it
// answers with.
const lastRunFor = (
  ctx: ServerContext,
  sessionId: string,
): LastRunRecord | undefined =>
  ctx.stopNotices === undefined
    ? undefined
    : readLastRun(ctx.stopNotices, sessionId);

const lastRunsFor = (
  ctx: ServerContext,
): Map<string, LastRunRecord> | undefined =>
  ctx.stopNotices === undefined ? undefined : readLastRuns(ctx.stopNotices);

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
    const lastRuns = lastRunsFor(ctx);
    return reply.send(
      ctx.sessions
        .listSessions({
          ...VIEWER_FILTER,
          limit: query.limit,
          offset: query.offset,
        })
        .map((row) => toApiSession(row, ctx.runner, lastRuns?.get(row.id))),
    );
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", (request, reply) => {
    // The query is validated before the session is looked up so a
    // malformed window reads as a client error either way.
    const query = parseDetailQuery(request);
    if (!query.ok) return reply.status(422).send({ error: query.error });
    const id = request.params.id;
    const session = ctx.sessions.getSession(id);
    if (session === undefined)
      return reply.status(404).send({ error: `No session ${id}.` });
    // fields=meta omits the transcript entirely; after=<index> slices
    // the store read itself, so a poll parses and serializes only the
    // messages it has not seen (#339).
    const messages = query.metaOnly
      ? undefined
      : ctx.sessions
          .listMessages(id)
          .slice(query.after ?? 0)
          .map(parseMessage);
    return reply.send({
      session: toApiSession(session, ctx.runner, lastRunFor(ctx, id)),
      ...(messages === undefined ? {} : { messages }),
    });
  });

  // The wait primitive (#341): one request parks while the session's run
  // is queued or running and answers the moment it settles — or at once
  // when none is active — so an orchestration script sequences runs
  // without holding its own poll loop. 200 answers a resolved wait (the
  // terminal status plus the persisted last_run verdict); 202 answers a
  // deadline that passed with the run still live, so the caller simply
  // calls again.
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/wait",
    async (request, reply) => {
      const query = parseWaitQuery(request);
      if (!query.ok) return reply.status(422).send({ error: query.error });
      const id = request.params.id;
      if (ctx.sessions.getSession(id) === undefined)
        return reply.status(404).send({ error: `No session ${id}.` });
      const outcome = await waitForRunSettle(
        ctx.runner,
        id,
        query.timeout,
        () => request.raw.destroyed,
      );
      // A caller that hung up mid-wait has nobody left to answer;
      // Fastify skips the send for an aborted request, so a plain
      // return is safe.
      if (request.raw.destroyed) return;
      return reply
        .status(outcome.settled ? 200 : 202)
        .send(
          toApiWaitResult(
            id,
            outcome.status,
            outcome.settled ? lastRunFor(ctx, id) : undefined,
          ),
        );
    },
  );

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

  // Fork: the copy runs through the same operation layer the browser's
  // action menu uses, so both surfaces fork identically. 201 names the
  // new session; status "created" when no prompt rode along, else where
  // the prompt sits ("started" | "queued").
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/fork",
    async (request, reply) => {
      const body = await parseForm(request);
      const result = await ops.forkSession(request.params.id, body);
      if (!result.ok)
        return reply.status(result.status).send({ error: result.error });
      reply.header("Location", `/api/sessions/${result.sessionId}`);
      return reply
        .status(201)
        .send({ id: result.sessionId, status: result.runStatus });
    },
  );

  // The prompts store is optional (app-less tests); when absent these
  // paths stay unregistered and 404 like the HTML prompt routes.
  const prompts = ctx.prompts;
  if (prompts !== undefined) {
    app.get("/api/prompts", (_request, reply) =>
      reply.send(listPrompts(prompts).map(toApiPrompt)),
    );
    app.get<{ Params: { id: string } }>(
      "/api/prompts/:id",
      (request, reply) => {
        const id = request.params.id;
        const prompt = getPrompt(prompts, id);
        if (prompt === undefined)
          return reply.status(404).send({ error: `No saved prompt ${id}.` });
        return reply.send(toApiPrompt(prompt));
      },
    );
  }

  // Scheduled runs: the same operation layer the browser's Scheduled
  // runs section delegates to, so a script schedules exactly what the
  // form would save.
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
    const result = await cronOps.createJob({
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

  // 202 because the answer says "started", not "finished" — the fire
  // runs in the background like any scheduled fire.
  app.post<{ Params: { name: string } }>(
    "/api/cron/:name/run",
    (request, reply) => {
      const run = ctx.runCronJob;
      if (run === undefined)
        return reply
          .status(501)
          .send({ error: "This server runs no cron scheduler." });
      const outcome = run(request.params.name);
      if (!outcome.ok)
        return reply.status(outcome.status).send({ error: outcome.error });
      return reply
        .status(202)
        .send({ name: request.params.name, status: "started" });
    },
  );

  // Behind auth like every other /api path — the document names no
  // secrets, but this is a single-owner app and the gate is uniform.
  app.get("/api/openapi.json", (_request, reply) =>
    reply.send(openApiDocument(VIEWER_FILTER.limit)),
  );
};

export { registerApiRoutes };
