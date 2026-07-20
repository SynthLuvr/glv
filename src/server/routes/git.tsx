import { type Hono } from "hono";
import { getSession, listMessages } from "../../db.js";
import { parseMessage } from "../../format/index.js";
import { readWorktreeByBranch } from "../../git.js";
import { detectPrUrl } from "../../pr.js";
import { resolvePrBranch } from "../../pr-state.js";
import { BranchChip, WorktreeChip } from "../../views/chips.js";
import type { ServerContext } from "../context.js";

// Resolve branch + worktree from the PR the session created and swap in chips
// via htmx. The branch comes from the PR link (via `gh`); the worktree is the
// local checkout on that branch. No PR link, or any failure → an empty body.
const registerGitRoutes = (app: Hono, ctx: ServerContext): void => {
  app.get("/sessions/:id/git-info", async (c) => {
    const id = c.req.param("id");
    const session = getSession(ctx.db, id);
    if (session === undefined) return c.html("");
    const prUrl = detectPrUrl(listMessages(ctx.db, id).map(parseMessage));
    if (prUrl === undefined) return c.html("");
    const branch = await resolvePrBranch(prUrl, ctx.runPrState);
    if (branch === undefined) return c.html("");
    const info = await readWorktreeByBranch(
      session.working_dir,
      ctx.runGit,
      branch,
    );
    return c.html(
      <>
        <BranchChip branch={branch} />
        {info.worktree !== undefined && (
          <WorktreeChip worktree={info.worktree} />
        )}
      </>,
    );
  });
};

export { registerGitRoutes };
