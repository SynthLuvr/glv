import { Hono } from "hono";
import { authMiddleware } from "../../glv/auth/service.js";
import type { SessionLauncher } from "../../glv/launch.js";
import { type Runner } from "../../glv/runner/index.js";
import { buildAssetBundle } from "../../glv/server/bundle.js";
import { expandHome, listHomeDirs } from "../../glv/server/paths.js";
import type { SessionStore } from "../../glv/sessions.js";
import { type ServerContext, type ServerOptions } from "./context.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBrowseRoutes } from "./routes/browse.js";
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
): Hono => {
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
    createLocks: new Map(),
    assets: buildAssetBundle(opts.profile.id),
  };

  const app = new Hono();
  // Auth gate sits first: every non-public request must carry a valid
  // session before any other middleware or route runs.
  if (ctx.auth !== undefined) app.use("*", authMiddleware(ctx.auth));

  registerAssetRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerBrowseRoutes(app, ctx);
  registerSidebarMetaRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  registerPrRoutes(app, ctx);
  registerGitRoutes(app, ctx);
  registerPromptRoutes(app, ctx);
  registerStreamRoutes(app, ctx);
  registerEventsRoutes(app, ctx);

  return app;
};

export { createApp, expandHome };
