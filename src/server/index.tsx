import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware } from "../auth/service.js";
import { type Runner } from "../runner/index.js";
import { buildAssetBundle } from "./bundle.js";
import { type ServerContext, type ServerOptions } from "./context.js";
import { expandHome, listHomeDirs } from "./paths.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerPrRoutes } from "./routes/pr.js";
import { registerPromptRoutes } from "./routes/prompts.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSidebarMetaRoutes } from "./routes/sidebarMeta.js";
import { registerStreamRoutes } from "./routes/stream.js";

const createApp = (
  db: DatabaseSync,
  runner: Runner,
  opts: ServerOptions = {},
): { app: Hono; reload: () => void } => {
  const ctx: ServerContext = {
    db,
    runner,
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
    assets: buildAssetBundle(),
    reloadSignal: { version: 0 },
  };

  const app = new Hono();
  // Auth gate sits first: every non-public request must carry a valid
  // session before any other middleware or route runs.
  if (ctx.auth !== undefined) app.use("*", authMiddleware(ctx.auth));

  registerAssetRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerSidebarMetaRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  registerPrRoutes(app, ctx);
  registerGitRoutes(app, ctx);
  registerPromptRoutes(app, ctx);
  registerStreamRoutes(app, ctx);
  registerEventsRoutes(app, ctx);

  // Re-reads dist/ into a fresh asset bundle and bumps the reload signal so
  // connected SSE clients know to refresh the page.
  const reload = (): void => {
    ctx.assets = buildAssetBundle();
    ctx.reloadSignal.version++;
  };

  return { app, reload };
};

export { createApp, expandHome };
