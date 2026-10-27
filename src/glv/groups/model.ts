import type { SessionRow } from "../sessions.js";
import type { GroupWithMembers } from "./db.js";

// A sidebar entry is either a standalone session, a collapsible group, or
// a collapsible orchestrator subtree (#385): a session other sessions
// were launched from, with its workers nested under it. A group only
// becomes an entry once it has ≥ 2 visible members; an orchestrator
// becomes one once ≥ 1 visible session links to it as parent.
type NestedEntry =
  | { kind: "session"; session: SessionRow }
  | { kind: "orchestrator"; parent: SessionRow; children: NestedEntry[] };

type ListEntry =
  | NestedEntry
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

// One session's visible parent, from the parent-link map (#385): the
// edge only counts when both endpoints are visible and neither is
// claimed by a visible user group — a worker its user grouped
// explicitly stays where the user put it, and a worker whose
// orchestrator is archived (or out of window) lists flat.
const visibleParentOf = (
  session: SessionRow,
  parents: ReadonlyMap<string, string> | undefined,
  byId: ReadonlyMap<string, SessionRow>,
  grouped: ReadonlySet<string>,
): SessionRow | undefined => {
  if (parents === undefined) return undefined;
  if (grouped.has(session.id)) return undefined;
  const parentId = parents.get(session.id);
  if (parentId === undefined) return undefined;
  const parent = byId.get(parentId);
  return parent !== undefined && !grouped.has(parent.id) ? parent : undefined;
};

// Collects the subtree rooted at `root` in recency order: the root plus
// every visible session that links to it (recursively — a worker may be
// an orchestrator itself). `seen` doubles as the caller's emitted set:
// every visited session lands in it, so later list rows inside the
// subtree are skipped — and a link cycle (impossible from the write
// path, possible from a hand-edited sidecar) cannot loop forever.
const collectSubtree = (
  root: SessionRow,
  childrenOf: ReadonlyMap<string, SessionRow[]>,
  seen: Set<string>,
): NestedEntry[] => {
  seen.add(root.id);
  const children: NestedEntry[] = [];
  for (const child of childrenOf.get(root.id) ?? []) {
    if (seen.has(child.id)) continue;
    const grandChildren = collectSubtree(child, childrenOf, seen);
    children.push(
      grandChildren.length > 0
        ? { kind: "orchestrator", parent: child, children: grandChildren }
        : { kind: "session", session: child },
    );
  }
  return children;
};

// The subtree's total size (root included) — the count badge.
const subtreeSize = (entry: NestedEntry): number =>
  entry.kind === "session"
    ? 1
    : 1 + entry.children.reduce((sum, child) => sum + subtreeSize(child), 0);

// The topmost visible ancestor: a worker of a worker nests under the
// whole chain's head, so one glance shows the loop's shape. The seen
// set guards against a link cycle, which the write path cannot produce
// but a hand-edited sidecar could.
const rootAncestorOf = (
  session: SessionRow,
  parentOf: (session: SessionRow) => SessionRow | undefined,
): SessionRow => {
  const seen = new Set<string>();
  let root = session;
  for (;;) {
    if (seen.has(root.id)) return root;
    seen.add(root.id);
    const parent = parentOf(root);
    if (parent === undefined) return root;
    root = parent;
  }
};

const buildEntries = (
  sessions: SessionRow[],
  groups: readonly GroupWithMembers[] | undefined,
  parents?: ReadonlyMap<string, string>,
): ListEntry[] => {
  // Link each visible member to its group, keeping only groups with ≥ 2
  // visible members.  `sessions` is recency-ordered, so a group's member
  // list is too.
  const sessionGroup = new Map<string, ActiveGroup>();
  for (const group of groups ?? []) {
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

  // The parent-link edges among sessions no visible group claimed.
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const grouped = new Set(sessionGroup.keys());
  const parentOf = (session: SessionRow): SessionRow | undefined =>
    visibleParentOf(session, parents, byId, grouped);
  const childrenOf = new Map<string, SessionRow[]>();
  for (const session of sessions) {
    const parent = parentOf(session);
    if (parent === undefined) continue;
    const bucket = childrenOf.get(parent.id);
    if (bucket === undefined) childrenOf.set(parent.id, [session]);
    else bucket.push(session);
  }

  // Emit each entry the first time one of its members appears (in recency
  // order); later members are skipped. A group emits at its newest
  // member's position; an orchestrator subtree likewise bubbles to its
  // newest member's. Ungrouped, unlinked sessions fall through as flat
  // entries.
  const emitted = new Set<string>();
  const entries: ListEntry[] = [];
  for (const session of sessions) {
    if (emitted.has(session.id)) continue;
    const group = sessionGroup.get(session.id);
    if (group === undefined) {
      const root = rootAncestorOf(session, parentOf);
      const children = collectSubtree(root, childrenOf, emitted);
      if (children.length > 0) {
        entries.push({ kind: "orchestrator", parent: root, children });
        continue;
      }
      emitted.add(session.id);
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

export type { ListEntry, NestedEntry };
export { buildEntries, subtreeSize };
