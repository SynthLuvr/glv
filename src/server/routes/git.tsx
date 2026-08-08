import { type Elysia } from "elysia";
import { getSession, listMessages } from "../../db.js";
import { parseMessage } from "../../format/index.js";
import { readWorktreeByBranch } from "../../git.js";
import { detectPrUrl } from "../../pr.js";
import { resolvePrBranch } from "../../pr-state.js";
import { BranchChip, WorktreeChip } from "../../views/chips.js";
import type { ServerContext } from "../context.js";
import { html } from "../http.js";

// Resolve branch + worktree from the PR the session created and swap in chips
// via htmx. The branch comes from the PR link (via `gh`); the worktree is the
// local checkout on that branch. No PR link, or any failure → an empty body.
const registerGitRoutes = (app: Elysia, ctx: ServerContext): void => {
  app.get("/sessions/:id/git-info", async (c) => {
    const id = c.params.id;
    const session = getSession(ctx.db, id);
    if (session === undefined) return html(c, "");
    const prUrl = detectPrUrl(listMessages(ctx.db, id).map(parseMessage));
    if (prUrl === undefined) return html(c, "");
    const branch = await resolvePrBranch(prUrl, ctx.runPrState);
    if (branch === undefined) return html(c, "");
    const info = await readWorktreeByBranch(
      session.working_dir,
      ctx.runGit,
      branch,
    );
    return html(
      c,
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
