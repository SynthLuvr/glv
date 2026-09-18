import type { FastifyInstance, FastifyReply } from "fastify";
import {
  addMember,
  createGroup,
  getGroup,
  groupIdOf,
  memberIdsOf,
  pruneBelowThreshold,
  removeMember,
  renameGroup,
} from "../../groups/db.js";
import { SessionList } from "../../views/Sidebar.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { parseForm } from "../forms.js";
import { param, sendHtml } from "../http.js";
import { sidebarEntries } from "../render.js";
import { activeSessionIds } from "../status.js";

// The groups sidecar is optional; when absent no routes register, so requests
// fall through to a 404.
const registerGroupRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  const groups = ctx.groups;
  if (groups === undefined) return;

  const renderList = (reply: FastifyReply) => {
    const sessions = ctx.sessions.listSessions(VIEWER_FILTER);
    return sendHtml(
      reply,
      <SessionList
        entries={sidebarEntries(ctx, sessions)}
        selectedId={undefined}
        runningIds={activeSessionIds(ctx.runner)}
        count={sessions.length}
      />,
    );
  };

  // Session ids currently shown in the sidebar — the threshold the prune rule
  // checks against.
  const visibleIds = (): Set<string> =>
    new Set(ctx.sessions.listSessions(VIEWER_FILTER).map((s) => s.id));

  // Join an existing group, or create one when groupId is empty.
  app.post("/sessions/:id/group", async (req, reply) => {
    const id = param(req, "id");
    const body = await parseForm(req);
    const groupId = typeof body.groupId === "string" ? body.groupId : "";
    if (groupId !== "") {
      if (getGroup(groups, groupId) === undefined) return reply.callNotFound();
      addMember(groups, groupId, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([groupId]));
    } else {
      const name = ctx.sessions.firstPromptSessionName([id]);
      const group = createGroup(groups, { name });
      addMember(groups, group.id, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([group.id]));
    }
    return renderList(reply);
  });

  // Remove a session; the group dissolves if it drops to ≤ 1 visible member.
  app.post("/sessions/:id/ungroup", (req, reply) => {
    const id = param(req, "id");
    removeMember(groups, id);
    pruneBelowThreshold(groups, visibleIds());
    return renderList(reply);
  });

  // Group two sessions.  If the target is already grouped the dragged session
  // joins it, otherwise a new group is created for both.
  app.post("/sessions/:id/group-with", async (req, reply) => {
    const id = param(req, "id");
    const body = await parseForm(req);
    const otherId = typeof body.otherId === "string" ? body.otherId : "";
    if (otherId !== "" && otherId !== id) {
      const existing = groupIdOf(groups, otherId);
      const targetId =
        existing ??
        createGroup(groups, {
          name: ctx.sessions.firstPromptSessionName([id, otherId]),
        }).id;
      if (existing === undefined) addMember(groups, targetId, otherId);
      addMember(groups, targetId, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([targetId]));
    }
    return renderList(reply);
  });

  app.post("/groups/:id/rename", async (req, reply) => {
    const id = param(req, "id");
    const body = await parseForm(req);
    const name = typeof body.name === "string" ? body.name : "";
    renameGroup(groups, id, name);
    return renderList(reply);
  });

  // Membership is retained so an un-archive can restore the group.
  app.post("/groups/:id/archive", (req, reply) => {
    const id = param(req, "id");
    if (getGroup(groups, id) === undefined) return reply.callNotFound();
    ctx.sessions.archiveSessions(memberIdsOf(groups, id));
    return renderList(reply);
  });
};

export { registerGroupRoutes };
