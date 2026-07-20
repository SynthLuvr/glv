import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware.js";
import { createGhClient } from "../gh.js";
import { type Runner, stop } from "../runner/index.js";
import {
  CLONE_JOB_SWEEP_MS,
  CLONE_JOB_TTL_MS,
  sweepCloneJobs,
} from "./cloneJobs.js";
import { type ServerContext, type ServerOptions } from "./context.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerPrRoutes } from "./routes/pr.js";
import { registerPromptRoutes } from "./routes/prompts.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSidebarMetaRoutes } from "./routes/sidebarMeta.js";
import { registerStreamRoutes } from "./routes/stream.js";
import { buildAssetBundle, expandHome, listHomeDirs } from "./util.js";

const createApp = (
  db: DatabaseSync,
  runner: Runner,
  opts: ServerOptions = {},
): Hono => {
  const ctx: ServerContext = {
    db,
    runner,
    gh: opts.gh ?? createGhClient(),
    auth: opts.auth,
    prompts: opts.prompts,
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
    cloneJobs: new Map(),
    cloneJobTtlMs: opts.cloneJobTtlMs ?? CLONE_JOB_TTL_MS,
    cloneJobSweepMs: opts.cloneJobSweepMs ?? CLONE_JOB_SWEEP_MS,
    createLocks: new Map(),
    assets: buildAssetBundle(),
  };

  // Background sweep; unref'd so it can't keep the process alive.
  if (ctx.cloneJobSweepMs > 0) {
    const sweep = (): void =>
      sweepCloneJobs(ctx.cloneJobs, ctx.cloneJobTtlMs, (key) =>
        stop(ctx.runner, key),
      );
    const timer = setInterval(sweep, ctx.cloneJobSweepMs);
    timer.unref();
  }

  const app = new Hono();
  // Auth gate sits first: every non-public request must carry a valid
  // session before any other middleware or route runs.
  if (ctx.auth !== undefined) app.use("*", authMiddleware(ctx.auth));

  registerAssetRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerGithubRoutes(app, ctx);
  registerSidebarMetaRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerPrRoutes(app, ctx);
  registerGitRoutes(app, ctx);
  registerPromptRoutes(app, ctx);
  registerStreamRoutes(app, ctx);
  registerEventsRoutes(app, ctx);

  return app;
};

export { createApp, expandHome, listHomeDirs };
