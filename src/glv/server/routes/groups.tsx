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
import { sendHtml, sendNotFound } from "../http.js";
import { sidebarEntries } from "../render.js";
import { activeSessionIds } from "../status.js";

const fieldString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  return typeof value === "string" ? value : "";
};

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
  app.post<{ Params: { id: string } }>(
    "/sessions/:id/group",
    async (request, reply) => {
      const id = request.params.id;
      const body = await parseForm(request);
      const groupId = fieldString(body, "groupId");
      if (groupId !== "") {
        if (getGroup(groups, groupId) === undefined) return sendNotFound(reply);
        addMember(groups, groupId, id);
        pruneBelowThreshold(groups, visibleIds(), new Set([groupId]));
      } else {
        const name = ctx.sessions.firstPromptSessionName([id]);
        const group = createGroup(groups, { name });
        addMember(groups, group.id, id);
        pruneBelowThreshold(groups, visibleIds(), new Set([group.id]));
      }
      return renderList(reply);
    },
  );

  // Remove a session; the group dissolves if it drops to ≤ 1 visible member.
  app.post<{ Params: { id: string } }>(
    "/sessions/:id/ungroup",
    (request, reply) => {
      removeMember(groups, request.params.id);
      pruneBelowThreshold(groups, visibleIds());
      return renderList(reply);
    },
  );

  // Group two sessions.  If the target is already grouped the dragged session
  // joins it, otherwise a new group is created for both.
  app.post<{ Params: { id: string } }>(
    "/sessions/:id/group-with",
    async (request, reply) => {
      const id = request.params.id;
      const body = await parseForm(request);
      const otherId = fieldString(body, "otherId");
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
    },
  );

  app.post<{ Params: { id: string } }>(
    "/groups/:id/rename",
    async (request, reply) => {
      const body = await parseForm(request);
      const name = fieldString(body, "name");
      renameGroup(groups, request.params.id, name);
      return renderList(reply);
    },
  );

  // Membership is retained so an un-archive can restore the group.
  app.post<{ Params: { id: string } }>(
    "/groups/:id/archive",
    (request, reply) => {
      const id = request.params.id;
      if (getGroup(groups, id) === undefined) return sendNotFound(reply);
      ctx.sessions.archiveSessions(memberIdsOf(groups, id));
      return renderList(reply);
    },
  );
};

export { registerGroupRoutes };
