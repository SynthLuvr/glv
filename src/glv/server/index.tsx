import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { authGate } from "../auth/service.js";
import type { SessionLauncher } from "../launch.js";
import { type Runner } from "../runner/index.js";
import type { SessionStore } from "../sessions.js";
import { buildAssetBundle } from "./bundle.js";
import { type ServerContext, type ServerOptions } from "./context.js";
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

// Uploads are enforced at the application layer (50 MB per file, 100 MB
// per batch), so the transport caps sit just above those ceilings and
// never reject what the app itself would accept.
const BODY_LIMIT = 110 * 1024 * 1024;
const MULTIPART_LIMITS = {
  fileSize: BODY_LIMIT,
  files: 20,
  fieldSize: 16 * 1024 * 1024,
};

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

  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT,
  });
  // Parsers before routes: cookies for the auth gate, form bodies for
  // htmx posts, multipart for uploads.
  void app.register(cookie);
  void app.register(formbody);
  void app.register(multipart, { limits: MULTIPART_LIMITS });

  // Plain-text 404/500 bodies, matching the responses htmx clients saw
  // from the previous framework layer.
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send("404 Not Found");
  });
  app.setErrorHandler(
    (err: { statusCode?: number; message: string }, _req, reply) => {
      const status =
        typeof err.statusCode === "number" && err.statusCode >= 400
          ? err.statusCode
          : 500;
      reply
        .code(status)
        .send(status >= 500 ? "Internal Server Error" : err.message);
    },
  );

  // Auth gate sits first: every non-public request must carry a valid
  // session before any route handler runs.
  if (ctx.auth !== undefined) app.addHook("preHandler", authGate(ctx.auth));

  registerAssetRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerBrowseRoutes(app, ctx);
  registerSidebarMetaRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  registerPrRoutes(app, ctx);
  registerGitRoutes(app, ctx);
  registerPromptRoutes(app, ctx);
  registerCronRoutes(app, ctx);
  registerStreamRoutes(app, ctx);
  registerEventsRoutes(app, ctx);

  return app;
};

export { createApp, expandHome };
