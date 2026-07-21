import { type Context, type Hono } from "hono";
import { listSessions } from "../../db.js";
import type { GroupWithMembers } from "../../groups/db.js";
import {
  addMember,
  createGroup,
  getGroup,
  groupIdOf,
  listGroups,
  pruneBelowThreshold,
  removeMember,
  renameGroup,
} from "../../groups/db.js";
import { SessionList } from "../../views/Sidebar.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { sidebarEntries } from "../render.js";
import { activeSessionIds } from "../status.js";

// Small inline form loaded into the session menu when "Move to group…" is
// clicked.  Lists every existing group plus a "New group" starter.
const GroupPicker = ({
  sessionId,
  groups,
}: {
  sessionId: string;
  groups: GroupWithMembers[];
}) => (
  <form
    class="group-picker-form"
    hx-post={`/sessions/${sessionId}/group`}
    hx-target="#session-list"
    hx-swap="outerHTML"
  >
    <select class="group-picker-select" name="groupId">
      <option value="">New group</option>
      {groups.map((g) => (
        <option value={g.id}>
          {g.name ?? "New group"} · {g.memberIds.length}
        </option>
      ))}
    </select>
    <button type="submit" class="group-picker-submit">
      Move
    </button>
    <button
      type="button"
      class="group-picker-cancel"
      data-action="cancel-group-menu"
    >
      Cancel
    </button>
  </form>
);

// The groups sidecar is optional (tests may omit it); when absent no routes
// are registered, so requests fall through to a 404.
const registerGroupRoutes = (app: Hono, ctx: ServerContext): void => {
  const groups = ctx.groups;
  if (groups === undefined) return;

  const renderList = (c: Context) => {
    const sessions = listSessions(ctx.db, VIEWER_FILTER);
    return c.html(
      <SessionList
        entries={sidebarEntries(ctx, sessions)}
        selectedId={undefined}
        runningIds={activeSessionIds(ctx.runner)}
      />,
    );
  };

  // Set of session ids currently visible in the sidebar (non-archived user
  // sessions) — the threshold the governing rule uses.
  const visibleIds = (): Set<string> =>
    new Set(listSessions(ctx.db, VIEWER_FILTER).map((s) => s.id));

  // Joins the session to an existing group, or creates a fresh one when
  // groupId is empty (the "New group" menu option).
  app.post("/sessions/:id/group", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const groupId = typeof body.groupId === "string" ? body.groupId : "";
    if (groupId !== "") {
      if (getGroup(groups, groupId) === undefined) return c.notFound();
      addMember(groups, groupId, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([groupId]));
    } else {
      const group = createGroup(groups);
      addMember(groups, group.id, id);
      pruneBelowThreshold(groups, visibleIds(), new Set([group.id]));
    }
    return renderList(c);
  });

  // Removes a session from its group.  If the group's visible membership
  // falls to ≤ 1 the group is dissolved entirely (survivor returns to the
  // flat list, indistinguishable from ungrouped).
  app.post("/sessions/:id/ungroup", (c) => {
    const id = c.req.param("id");
    removeMember(groups, id);
    pruneBelowThreshold(groups, visibleIds());
    return renderList(c);
  });

  // Groups the dragged session with another.  If the target is already in a
  // group the dragged session joins it; otherwise a new group is created for
  // both.
  app.post("/sessions/:id/group-with", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const otherId = typeof body.otherId === "string" ? body.otherId : "";
    if (otherId !== "" && otherId !== id) {
      const existing = groupIdOf(groups, otherId);
      const targetId = existing ?? createGroup(groups).id;
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

  // Returns the inline picker loaded into the session's group-menu slot.
  app.get("/sessions/:id/group-picker", (c) => {
    const id = c.req.param("id");
    return c.html(<GroupPicker sessionId={id} groups={listGroups(groups)} />);
  });
};

export { registerGroupRoutes };
