import type { SessionRow } from "../db.js";
import type { GroupWithMembers } from "./db.js";

// A sidebar entry is either a standalone session or a collapsible group.  A
// group only becomes an entry once it has ≥ 2 visible members.
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

type ActiveGroup = {
  groupId: string;
  name: string;
  members: SessionRow[];
};

const buildEntries = (
  sessions: SessionRow[],
  groups: readonly GroupWithMembers[] | undefined,
): ListEntry[] => {
  if (groups === undefined || groups.length === 0)
    return sessions.map((session) => ({ kind: "session", session }));

  // Link each visible member to its group, keeping only groups with ≥ 2 visible
  // members.  `sessions` is recency-ordered, so a group's member list is too.
  const sessionGroup = new Map<string, ActiveGroup>();
  for (const group of groups) {
    const memberIds = new Set(group.memberIds);
    const members = sessions.filter((s) => memberIds.has(s.id));
    if (members.length < 2) continue;
    const active = {
      groupId: group.id,
      name: group.name ?? DEFAULT_GROUP_NAME,
      members,
    };
    for (const m of members) sessionGroup.set(m.id, active);
  }

  // Emit a group the first time one of its members appears (in recency order);
  // later members are skipped.  Ungrouped sessions fall through as flat entries.
  const emitted = new Set<string>();
  const entries: ListEntry[] = [];
  for (const session of sessions) {
    if (emitted.has(session.id)) continue;
    const group = sessionGroup.get(session.id);
    if (group === undefined) {
      entries.push({ kind: "session", session });
      continue;
    }
    entries.push({
      kind: "group",
      groupId: group.groupId,
      groupName: group.name,
      memberCount: group.members.length,
      members: group.members,
    });
    for (const m of group.members) emitted.add(m.id);
  }
  return entries;
};

export type { ListEntry };
export { buildEntries };
