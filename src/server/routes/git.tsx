import { type Hono } from "hono";
import { getSession } from "../../db.js";
import { readGitInfo } from "../../git.js";
import { BranchChip, WorktreeChip } from "../../views/transcript.js";
import type { AppEnv, ServerContext } from "../context.js";

// Resolve branch + worktree from local git and swap in chips via htmx. A
// non-repo, missing session, or any failure → an empty body (nothing renders).
const registerGitRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  app.get("/sessions/:id/git-info", async (c) => {
    const session = getSession(ctx.db, c.req.param("id"));
    if (session === undefined) return c.html("");
    const info = await readGitInfo(session.working_dir, ctx.runGit);
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
