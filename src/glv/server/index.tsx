import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import sse from "@fastify/sse";
import Fastify, { type FastifyInstance } from "fastify";
import { splitNamespacedId } from "../agents.js";
import { authMiddleware } from "../auth/service.js";
import type { AgentDispatchLauncher } from "../composite-launcher.js";
import { type Runner } from "../runner/index.js";
import type { SessionStore } from "../sessions.js";
import { buildAssetBundle } from "./bundle.js";
import {
  type AgentRuntime,
  type ServerContext,
  type ServerOptions,
} from "./context.js";
import { createCronOperations } from "./cron-operations.js";
import { sendNotFound } from "./http.js";
import { createSessionOperations } from "./operations.js";
import { expandHome, listHomeDirs } from "./paths.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBrowseRoutes } from "./routes/browse.js";
import { registerCronRoutes } from "./routes/cron.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerPrRoutes } from "./routes/pr.js";
import { registerPromptRoutes } from "./routes/prompts.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSidebarMetaRoutes } from "./routes/sidebarMeta.js";
import { registerStreamRoutes } from "./routes/stream.js";
import { registerTokenBootstrapRoute } from "./routes/token-bootstrap.js";
import { registerTokenRoutes } from "./routes/tokens.js";

const createApp = (
  sessions: SessionStore,
  launcher: AgentDispatchLauncher,
  runner: Runner,
  opts: ServerOptions,
): FastifyInstance => {
  const agents = opts.agents;
  const multiAgent = agents.length > 1;
  // Single-agent servers have no ambiguity to resolve — every id belongs
  // to the sole agent whether or not it carries the namespace. Multi-
  // agent servers resolve the agent from the id's prefix; an unprefixed
  // id (which only a multi-agent store never mints) matches nothing.
  const agentOf = (id: string): AgentRuntime | undefined => {
    if (!multiAgent) return agents[0];
    const split = splitNamespacedId(id);
    return split === undefined
      ? undefined
      : agents.find((runtime) => runtime.id === split.agent);
  };
  const ctx: ServerContext = {
    sessions,
    launcher,
    runner,
    agents,
    agentOf,
    defaultAgent: agents[0],
    agentNames: agents.map((runtime) => runtime.profile.agentName).join(" + "),
    dataDirName: opts.dataDirName,
    auth: opts.auth,
    prompts: opts.prompts,
    groups: opts.groups,
    allowTokenBootstrap: opts.allowTokenBootstrap ?? false,
    suggestions: opts.suggestions,
    rpName: opts.rpName,
    rpIdOverride: opts.rpIdOverride,
    listDirs: opts.listDirs ?? listHomeDirs,
    tailPollMs: opts.tailPollMs ?? 1000,
    maxTailPolls: opts.maxTailPolls ?? Infinity,
    pollTimeoutMs: opts.pollTimeoutMs ?? 10000,
    statusPollMs: opts.statusPollMs ?? 1000,
    maxStatusPolls: opts.maxStatusPolls ?? Infinity,
    runPrState: opts.runPrState,
    runGit: opts.runGit,
    cronDb: opts.cronDb,
    stopNotices: opts.stopNotices,
    onCronJobsChange: opts.onCronJobsChange,
    runCronJob: opts.runCronJob,
    assets: buildAssetBundle(opts.assetsFlavor),
  };

  const ops = createSessionOperations(ctx);
  const cronOps = createCronOperations(ctx);
  // Uploads ride the body parser: the friendly per-file (50 MB) and
  // total (100 MB) checks live in saveUploads, so the framework limits
  // sit above them to let those errors surface instead of a hard 413.
  const UPLOAD_BODY_LIMIT = 110 * 1024 * 1024;

  const app = Fastify({
    logger: false,
    bodyLimit: UPLOAD_BODY_LIMIT,
  });

  // JSON bodies arrive as the raw string. The WebAuthn verify endpoints
  // parse leniently and answer with their own 400 shape (parity with the
  // previous framework, where parsing happened inside the handler);
  // Fastify's default parser would reject malformed JSON with its own
  // error body before any handler runs.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.register(cookie);
  // urlencoded form bodies (every plain htmx submit).
  app.register(formbody);
  // multipart form bodies (file uploads), parts attached to request.body
  // and normalized by server/forms.ts.
  app.register(multipart, {
    attachFieldsToBody: true,
    limits: {
      fileSize: UPLOAD_BODY_LIMIT,
      files: 20,
      fields: 200,
    },
  });

  // SSE framing for the two event-stream routes (`sse: "only"`). The
  // heartbeat is off — the poll loops bound their own lifetimes, and a
  // comment frame would be wire bytes this app has never sent — and the
  // serializer is the identity because payloads arrive pre-serialized:
  // sse-events validates and stringifies before the wire, so the plugin's
  // default JSON.stringify would double-quote every frame.
  app.register(sse, {
    heartbeatInterval: 0,
    serializer: (data) => (typeof data === "string" ? data : String(data)),
  });

  // The token bootstrap lives at the app root, ahead of the auth-gated
  // scope below: it must answer without a credential, because a
  // credential is what it mints. No-op unless the flag is on, so the
  // default server never has the route.
  registerTokenBootstrapRoute(app, ctx);

  // Registered inside a scope so the auth gate — an onRequest hook — runs
  // after @fastify/cookie's root-level parse hook (parent hooks run first)
  // and before every route handler.
  app.register(async (scope) => {
    if (ctx.auth !== undefined)
      scope.addHook("onRequest", authMiddleware(ctx.auth));
    scope.setNotFoundHandler((_request, reply) => sendNotFound(reply));

    registerAssetRoutes(scope, ctx);
    registerAuthRoutes(scope, ctx);
    registerBrowseRoutes(scope, ctx);
    registerSidebarMetaRoutes(scope, ctx);
    registerSessionRoutes(scope, ctx, ops);
    registerGroupRoutes(scope, ctx);
    registerPrRoutes(scope, ctx);
    registerGitRoutes(scope, ctx);
    registerPromptRoutes(scope, ctx);
    registerCronRoutes(scope, ctx, cronOps);
    registerStreamRoutes(scope, ctx);
    registerEventsRoutes(scope, ctx);
    registerTokenRoutes(scope, ctx);
    registerApiRoutes(scope, ctx, ops, cronOps);
  });

  return app;
};

export { createApp, expandHome };
