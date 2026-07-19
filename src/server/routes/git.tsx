import { type Hono } from "hono";
import { getSession, listMessages } from "../../db.js";
import { extractCandidatePaths, parseMessage } from "../../format/index.js";
import { readGitInfo } from "../../git.js";
import { BranchChip, WorktreeChip } from "../../views/chips.js";
import type { AppEnv, ServerContext } from "../context.js";

// Resolve branch + worktree from local git and swap in chips via htmx. A
// non-repo, missing session, or any failure → an empty body (nothing renders).
const registerGitRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  app.get("/sessions/:id/git-info", async (c) => {
    const id = c.req.param("id");
    const session = getSession(ctx.db, id);
    if (session === undefined) return c.html("");
    // Recover the worktree the session actually worked in from its tool calls:
    // a session launched from `main` that `git worktree add`s and works there
    // should report that branch, not the launch dir's.
    const dirs = extractCandidatePaths(
      listMessages(ctx.db, id).map(parseMessage),
    );
    const info = await readGitInfo(session.working_dir, ctx.runGit, dirs);
    return c.html(
      <>
        {info.branch !== undefined && <BranchChip branch={info.branch} />}
        {info.worktree !== undefined && (
          <WorktreeChip worktree={info.worktree} />
        )}
      </>,
    );
  });
};

export { registerGitRoutes };
