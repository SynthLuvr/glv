import type { SessionRow } from "../db.js";
import type { GroupWithMembers } from "./db.js";

// A discriminated entry for the sidebar list.  Either a standalone session or
// a collapsible group with its visible members.  The governing rule lives
// here: a group only appears as an entry when it has ≥ 2 visible (i.e.
// present-in-the-sidebar, non-archived) members.

type ListEntry =
  | { kind: "session"; session: SessionRow }
  | {
      kind: "group";
      groupId: string;
      groupName: string;
      memberCount: number;
      members: SessionRow[];
    };

const DEFAULT_GROUP_NAME = "New group";

// Sessions that are members of a group but not currently visible (archived,
// filtered out) are invisible.  Only groups with ≥ 2 visible members render;
// members of non-rendering groups fall through as flat session entries so
// they are indistinguishable from ungrouped sessions.
const buildEntries = (
  sessions: SessionRow[],
  groups: readonly GroupWithMembers[] | undefined,
): ListEntry[] => {
  if (groups === undefined || groups.length === 0)
    return sessions.map((session) => ({ kind: "session", session }));

  // Resolve each group to its visible members (those present in the session
  // list) and keep only groups with ≥ 2 visible members.
  const activeGroups = new Map<
    string,
    { name: string; members: SessionRow[] }
  >();
  const sessionToGroup = new Map<string, string>();
  for (const group of groups) {
    const memberSet = new Set(group.memberIds);
    // sessions is already recency-ordered (updated_at DESC), so filtering
    // preserves that order for the group's member list.
    const visible = sessions.filter((s) => memberSet.has(s.id));
    if (visible.length < 2) continue;
    activeGroups.set(group.id, {
      name: group.name ?? DEFAULT_GROUP_NAME,
      members: visible,
    });
    for (const s of visible) sessionToGroup.set(s.id, group.id);
  }

  // Walk sessions in recency order (they already are).  Emit a group entry
  // the first time we encounter one of its members; skip subsequent members.
  const emitted = new Set<string>();
  const entries: ListEntry[] = [];
  for (const session of sessions) {
    if (emitted.has(session.id)) continue;
    const groupId = sessionToGroup.get(session.id);
    if (groupId !== undefined) {
      const group = activeGroups.get(groupId);
      if (group !== undefined) {
        entries.push({
          kind: "group",
          groupId,
          groupName: group.name,
          memberCount: group.members.length,
          members: group.members,
        });
        for (const m of group.members) emitted.add(m.id);
        continue;
      }
    }
    entries.push({ kind: "session", session });
  }
  return entries;
};

export type { ListEntry };
export { buildEntries, DEFAULT_GROUP_NAME };
