import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import sse from "@fastify/sse";
import Fastify, { type FastifyInstance } from "fastify";
import { authMiddleware } from "../auth/service.js";
import type { SessionLauncher } from "../launch.js";
import { type Runner } from "../runner/index.js";
import type { SessionStore } from "../sessions.js";
import { buildAssetBundle } from "./bundle.js";
import { type ServerContext, type ServerOptions } from "./context.js";
import { sendNotFound } from "./http.js";
import { expandHome, listHomeDirs } from "./paths.js";
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

const createApp = (
  sessions: SessionStore,
  launcher: SessionLauncher,
  runner: Runner,
  opts: ServerOptions,
): FastifyInstance => {
  const ctx: ServerContext = {
    sessions,
    launcher,
    runner,
    profile: opts.profile,
    auth: opts.auth,
    prompts: opts.prompts,
    groups: opts.groups,
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
    models: opts.models,
    cronDb: opts.cronDb,
    onCronJobsChange: opts.onCronJobsChange,
    createLocks: new Map(),
    assets: buildAssetBundle(opts.profile.id),
  };

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
    registerSessionRoutes(scope, ctx);
    registerGroupRoutes(scope, ctx);
    registerPrRoutes(scope, ctx);
    registerGitRoutes(scope, ctx);
    registerPromptRoutes(scope, ctx);
    registerCronRoutes(scope, ctx);
    registerStreamRoutes(scope, ctx);
    registerEventsRoutes(scope, ctx);
  });

  return app;
};

export { createApp, expandHome };
