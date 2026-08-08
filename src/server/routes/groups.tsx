import { type Elysia } from "elysia";
import {
  archiveSessions,
  firstPromptSessionName,
  listSessions,
} from "../../db.js";
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
import { html, type LooseContext, notFound, parseBody } from "../http.js";
import { sidebarEntries } from "../render.js";
import { activeSessionIds } from "../status.js";

// The groups sidecar is optional; when absent no routes register, so requests
// fall through to a 404.
const registerGroupRoutes = (app: Elysia, ctx: ServerContext): void => {
  const groups = ctx.groups;
  if (groups === undefined) return;

  const renderList = (c: LooseContext) => {
    const sessions = listSessions(ctx.db, VIEWER_FILTER);
    return html(
      c,
      <SessionList
        entries={sidebarEntries(ctx, sessions)}
        selectedId={undefined}
        runningIds={activeSessionIds(ctx.runner)}
      />,
    );
  };

  // Session ids currently shown in the sidebar — the threshold the prune rule
  // checks against.
  const visibleIds = (): Set<string> =>
    new Set(listSessions(ctx.db, VIEWER_FILTER).map((s) => s.id));

  // Join an existing group, or create one when groupId is empty.
  app.post("/sessions/:id/group", async (c) => {
    const id = c.params.id;
    const body = await parseBody(c);
    const groupId = typeof body.groupId === "string" ? body.groupId : "";
    if (groupId !== "") {
      if (getGroup(groups, groupId) === undefined) return notFound(c);
      addMember(groups, groupId, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([groupId]));
    } else {
      const name = firstPromptSessionName(ctx.db, [id]);
      const group = createGroup(groups, { name });
      addMember(groups, group.id, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([group.id]));
    }
    return renderList(c);
  });

  // Remove a session; the group dissolves if it drops to ≤ 1 visible member.
  app.post("/sessions/:id/ungroup", (c) => {
    const id = c.params.id;
    removeMember(groups, id);
    pruneBelowThreshold(groups, visibleIds());
    return renderList(c);
  });

  // Group two sessions.  If the target is already grouped the dragged session
  // joins it, otherwise a new group is created for both.
  app.post("/sessions/:id/group-with", async (c) => {
    const id = c.params.id;
    const body = await parseBody(c);
    const otherId = typeof body.otherId === "string" ? body.otherId : "";
    if (otherId !== "" && otherId !== id) {
      const existing = groupIdOf(groups, otherId);
      const targetId =
        existing ??
        createGroup(groups, {
          name: firstPromptSessionName(ctx.db, [id, otherId]),
        }).id;
      if (existing === undefined) addMember(groups, targetId, otherId);
      addMember(groups, targetId, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([targetId]));
    }
    return renderList(c);
  });

  app.post("/groups/:id/rename", async (c) => {
    const id = c.params.id;
    const body = await parseBody(c);
    const name = typeof body.name === "string" ? body.name : "";
    renameGroup(groups, id, name);
    return renderList(c);
  });

  // Membership is retained so an un-archive can restore the group.
  app.post("/groups/:id/archive", (c) => {
    const id = c.params.id;
    if (getGroup(groups, id) === undefined) return notFound(c);
    archiveSessions(ctx.dbWritable, memberIdsOf(groups, id));
    return renderList(c);
  });
};

export { registerGroupRoutes };
