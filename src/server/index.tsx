import type { DatabaseSync } from "node:sqlite";
import { node } from "@elysiajs/node";
import { parse } from "cookie";
import { Elysia } from "elysia";
import {
  COOKIE_NAME,
  isPublicPath,
  setSessionCookie,
} from "../auth/service.js";
import { type Runner } from "../runner/index.js";
import { buildAssetBundle } from "./bundle.js";
import { type ServerContext, type ServerOptions } from "./context.js";
import { expandHome, listHomeDirs } from "./paths.js";
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
  db: DatabaseSync,
  dbWritable: DatabaseSync,
  runner: Runner,
  opts: ServerOptions = {},
): Elysia => {
  const ctx: ServerContext = {
    db,
    dbWritable,
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
  };

  const app = new Elysia({ adapter: node() });

  // Auth gate: every non-public request must carry a valid session before any
  // route handler runs. The redirect must be built and returned inline (not via
  // a helper) — Elysia's compile-time analysis only wires the beforeHandle
  // short-circuit when the Response is returned directly from this arrow.
  if (ctx.auth !== undefined) {
    const auth = ctx.auth;
    app.onBeforeHandle((c) => {
      const path = new URL(c.request.url).pathname;
      if (isPublicPath(path)) return;
      const token = parse(c.request.headers.get("cookie") ?? "")[COOKIE_NAME];
      if (token !== undefined && token !== "" && auth.isValidSession(token)) {
        setSessionCookie(c, token);
        return;
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: auth.isClaimed() ? "/auth/login" : "/auth/register",
        },
      });
    });
  }

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
