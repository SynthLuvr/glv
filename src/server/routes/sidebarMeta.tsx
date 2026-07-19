import type { DatabaseSync } from "node:sqlite";
import { type Hono } from "hono";
import { Fragment } from "hono/jsx";
import {
  listMessages,
  listSessions,
  prCandidateIds,
  type SessionRow,
} from "../../db.js";
import { parseMessage } from "../../format/index.js";
import { type GitRunner, readGitInfo } from "../../git.js";
import { detectPrUrl } from "../../pr.js";
import { BranchChip, PrChip } from "../../views/chips.js";
import type { AppEnv, ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";

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

// Resolves branch + PR for every sidebar session in one lazy request and
// returns one out-of-band swap fragment per session into each item's
// `#sidebar-meta-<id>` slot — so a list of any size is one request, not one
// per item.
const registerSidebarMetaRoutes = (
  app: Hono<AppEnv>,
  ctx: ServerContext,
): void => {
  app.get("/sessions/sidebar-meta", async (c) => {
    const sessions = listSessions(ctx.db, VIEWER_FILTER);
    const branches = await resolveBranches(sessions, ctx.runGit);
    const prUrls = resolvePrUrls(ctx.db, sessions);
    return c.html(
      <Fragment>
        {sessions.map((session) => {
          const branch = branches.get(session.id);
          const prUrl = prUrls.get(session.id);
          return (
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
        })}
      </Fragment>,
    );
  });
};

export { registerSidebarMetaRoutes };
