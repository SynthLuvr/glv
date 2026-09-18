import type { FastifyInstance } from "fastify";
import { parseMessage } from "../../format/index.js";
import { readWorktreeByBranch } from "../../git.js";
import { detectPrUrl } from "../../pr.js";
import { resolvePrBranch } from "../../pr-state.js";
import { BranchChip, WorktreeChip } from "../../views/chips.js";
import type { ServerContext } from "../context.js";
import { sendHtml } from "../http.js";

// Resolve branch + worktree from the PR the session created and swap in chips
// via htmx. The branch comes from the PR link (via `gh`); the worktree is the
// local checkout on that branch. No PR link, or any failure → an empty body.
const registerGitRoutes = (app: FastifyInstance, ctx: ServerContext): void => {
  app.get<{ Params: { id: string } }>(
    "/sessions/:id/git-info",
    async (request, reply) => {
      const id = request.params.id;
      const session = ctx.sessions.getSession(id);
      if (session === undefined) return sendHtml(reply, "");
      const prUrl = detectPrUrl(
        ctx.sessions.listMessages(id).map(parseMessage),
      );
      if (prUrl === undefined) return sendHtml(reply, "");
      const branch = await resolvePrBranch(prUrl, ctx.runPrState);
      if (branch === undefined) return sendHtml(reply, "");
      const info = await readWorktreeByBranch(
        session.working_dir,
        ctx.runGit,
        branch,
      );
      return sendHtml(
        reply,
        <>
          <BranchChip branch={branch} />
          {info.worktree !== undefined && (
            <WorktreeChip worktree={info.worktree} />
          )}
        </>,
      );
    },
  );
};

export { registerGitRoutes };
