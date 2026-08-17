import { type Context, type Hono } from "hono";
import {
  addMember,
  createGroup,
  getGroup,
  groupIdOf,
  memberIdsOf,
  pruneBelowThreshold,
  removeMember,
  renameGroup,
} from "../../../glv/groups/db.js";
import { SessionList } from "../../../glv/views/Sidebar.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { sidebarEntries } from "../render.js";
import { activeSessionIds } from "../status.js";

// The groups sidecar is optional; when absent no routes register, so requests
// fall through to a 404.
const registerGroupRoutes = (app: Hono, ctx: ServerContext): void => {
  const groups = ctx.groups;
  if (groups === undefined) return;

  const renderList = (c: Context) => {
    const sessions = ctx.sessions.listSessions(VIEWER_FILTER);
    return c.html(
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
    new Set(ctx.sessions.listSessions(VIEWER_FILTER).map((s) => s.id));

  // Join an existing group, or create one when groupId is empty.
  app.post("/sessions/:id/group", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const groupId = typeof body.groupId === "string" ? body.groupId : "";
    if (groupId !== "") {
      if (getGroup(groups, groupId) === undefined) return c.notFound();
      addMember(groups, groupId, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([groupId]));
    } else {
      const name = ctx.sessions.firstPromptSessionName([id]);
      const group = createGroup(groups, { name });
      addMember(groups, group.id, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([group.id]));
    }
    return renderList(c);
  });

  // Remove a session; the group dissolves if it drops to ≤ 1 visible member.
  app.post("/sessions/:id/ungroup", (c) => {
    const id = c.req.param("id");
    removeMember(groups, id);
    pruneBelowThreshold(groups, visibleIds());
    return renderList(c);
  });

  // Group two sessions.  If the target is already grouped the dragged session
  // joins it, otherwise a new group is created for both.
  app.post("/sessions/:id/group-with", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
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
    return renderList(c);
  });

  app.post("/groups/:id/rename", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name : "";
    renameGroup(groups, id, name);
    return renderList(c);
  });

  // Membership is retained so an un-archive can restore the group.
  app.post("/groups/:id/archive", (c) => {
    const id = c.req.param("id");
    if (getGroup(groups, id) === undefined) return c.notFound();
    ctx.sessions.archiveSessions(memberIdsOf(groups, id));
    return renderList(c);
  });
};

export { registerGroupRoutes };
