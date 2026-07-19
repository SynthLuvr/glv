import { type Hono } from "hono";
import { Fragment } from "hono/jsx";
import { getSession } from "../../db.js";
import { readGitInfo } from "../../git.js";
import { BranchChip, WorktreeChip } from "../../views/transcript.js";
import type { AppEnv, ServerContext } from "../context.js";

// Lazily resolve the branch + worktree via a single local `git worktree list`
// call and swap in display chips alongside the PR chip. A non-repo, a missing
// session, or any failure → an empty body, so nothing renders.
const registerGitRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  app.get("/sessions/:id/git-info", async (c) => {
    const session = getSession(ctx.db, c.req.param("id"));
    if (session === undefined) return c.html("");
    const info = await readGitInfo(session.working_dir, ctx.runGit);
    return c.html(
      <Fragment>
        {info.branch !== undefined && <BranchChip branch={info.branch} />}
        {info.worktree !== undefined && (
          <WorktreeChip worktree={info.worktree} />
        )}
      </Fragment>,
    );
  });
};

export { registerGitRoutes };
