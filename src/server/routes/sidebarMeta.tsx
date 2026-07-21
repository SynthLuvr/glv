import type { DatabaseSync } from "node:sqlite";
import { type Hono } from "hono";
import { Fragment } from "hono/jsx";
import {
  getSession,
  listMessages,
  listSessions,
  prCandidateIds,
  type SessionRow,
} from "../../db.js";
import { parseMessage } from "../../format/index.js";
import { type GitRunner, readGitInfo } from "../../git.js";
import { detectPrUrl } from "../../pr.js";
import { BranchChip, PrChip } from "../../views/chips.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { activeSessionIds } from "../status.js";

// One git lookup per unique working dir, not one per session; a non-repo or
// any failure just yields no branch.
const resolveBranches = async (
  sessions: readonly SessionRow[],
  runGit: GitRunner | undefined,
): Promise<Map<string, string>> => {
  if (runGit === undefined) return new Map();
  const branchByDir = new Map<string, string>();
  await Promise.all(
    [...new Set(sessions.map((s) => s.working_dir))].map(async (dir) => {
      const { branch } = await readGitInfo(dir, runGit);
      if (branch !== undefined) branchByDir.set(dir, branch);
    }),
  );
  const result = new Map<string, string>();
  for (const session of sessions) {
    const branch = branchByDir.get(session.working_dir);
    if (branch !== undefined) result.set(session.id, branch);
  }
  return result;
};

// A SQL pre-filter trims to sessions that mention a pull URL, so only those
// few get their messages parsed.
const resolvePrUrls = (
  db: DatabaseSync,
  sessions: readonly SessionRow[],
): Map<string, string> => {
  const candidates = prCandidateIds(
    db,
    sessions.map((s) => s.id),
  );
  const result = new Map<string, string>();
  for (const session of sessions) {
    if (!candidates.has(session.id)) continue;
    const url = detectPrUrl(listMessages(db, session.id).map(parseMessage));
    if (url !== undefined) result.set(session.id, url);
  }
  return result;
};

// Renders the chips (branch + PR) for one sidebar session into its
// out-of-band `#sidebar-meta-<id>` swap slot. The PR badge is withheld while a
// session is still running: detection runs over a half-written transcript and
// can latch onto the wrong URL, so it only resolves once the run is complete.
const renderMeta = (
  session: SessionRow,
  branch: string | undefined,
  prUrl: string | undefined,
) => (
  <span
    id={`sidebar-meta-${session.id}`}
    class="session-meta-tags"
    hx-swap-oob="true"
  >
    {branch !== undefined && <BranchChip branch={branch} compact />}
    {prUrl !== undefined && (
      <PrChip sessionId={session.id} url={prUrl} compact />
    )}
  </span>
);

// Resolves branch + PR for every sidebar session in one lazy request and
// returns one out-of-band swap fragment per session into each item's
// `#sidebar-meta-<id>` slot — so a list of any size is one request, not one
// per item. A per-session variant lets a just-completed run refresh only its
// own slot, revealing a PR badge that was withheld while it was running.
const registerSidebarMetaRoutes = (app: Hono, ctx: ServerContext): void => {
  app.get("/sessions/:id/sidebar-meta", async (c) => {
    const id = c.req.param("id");
    const session = getSession(ctx.db, id);
    if (session === undefined) return c.notFound();
    const branches = await resolveBranches([session], ctx.runGit);
    const prUrl = activeSessionIds(ctx.runner).has(id)
      ? undefined
      : resolvePrUrls(ctx.db, [session]).get(id);
    return c.html(renderMeta(session, branches.get(id), prUrl));
  });

  app.get("/sessions/sidebar-meta", async (c) => {
    const sessions = listSessions(ctx.db, VIEWER_FILTER);
    const runningIds = activeSessionIds(ctx.runner);
    const branches = await resolveBranches(sessions, ctx.runGit);
    const prUrls = resolvePrUrls(ctx.db, sessions);
    return c.html(
      <Fragment>
        {sessions.map((session) => {
          const branch = branches.get(session.id);
          const prUrl = runningIds.has(session.id)
            ? undefined
            : prUrls.get(session.id);
          return renderMeta(session, branch, prUrl);
        })}
      </Fragment>,
    );
  });
};

export { registerSidebarMetaRoutes };
