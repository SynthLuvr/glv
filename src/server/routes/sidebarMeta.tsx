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
import { SidebarBranchChip, SidebarPrChip } from "../../views/Sidebar.js";
import type { AppEnv, ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";

// Dedupe git lookups by working dir so N sessions in one repo spawn a single
// `git worktree list` rather than N. Any failure degrades to "no branch".
const resolveBranches = async (
  sessions: readonly SessionRow[],
  runGit: GitRunner | undefined,
): Promise<Map<string, string>> => {
  const byDir = new Map<string, string[]>();
  for (const session of sessions) {
    const ids = byDir.get(session.working_dir) ?? [];
    ids.push(session.id);
    byDir.set(session.working_dir, ids);
  }
  const result = new Map<string, string>();
  if (runGit === undefined) return result;
  await Promise.all(
    [...byDir.entries()].map(async ([dir, ids]) => {
      const info = await readGitInfo(dir, runGit);
      if (info.branch === undefined) return;
      for (const id of ids) result.set(id, info.branch);
    }),
  );
  return result;
};

// A SQL pre-filter trims to only sessions that mention a pull URL, so the
// sidebar parses messages for those few rather than every session.
const resolvePrUrls = (
  db: ServerContext["db"],
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

// One lazy request resolves branch + PR for every sidebar session and returns
// out-of-band swap fragments — one per session — that htmx places into each
// item's `#sidebar-meta-<id>` slot. A plain (non-htmx) GET returns the same
// fragment body so the endpoint stays testable without a full shell.
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
              {branch !== undefined && <SidebarBranchChip branch={branch} />}
              {prUrl !== undefined && (
                <SidebarPrChip id={session.id} url={prUrl} />
              )}
            </span>
          );
        })}
      </Fragment>,
    );
  });
};

export { registerSidebarMetaRoutes };
