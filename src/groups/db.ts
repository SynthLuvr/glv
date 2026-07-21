import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { ensureDbDir, resolveDataPath } from "../db-path.js";
import { transaction, validate, validateAll } from "../query.js";

// Viewer-owned sidecar that records manual session grouping.  Deliberately
// separate from goose's sessions.db (which glv opens read-only) so goose
// schema migrations never touch this data, and so archive/restore works:
// archiving a session hides it from the sidebar but never deletes its group
// membership here — un-archiving restores visibility and the group reappears
// if ≥ 2 members are visible again.

type SessionGroup = {
  id: string;
  name: string | null;
  createdAt: string;
};

type GroupWithMembers = {
  id: string;
  name: string | null;
  memberIds: string[];
};

type GroupInput = {
  name?: string;
};

const resolveGroupsDbPath = (override?: string): string =>
  resolveDataPath(override, "GLV_GROUPS_DB", "glv", "groups.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id   TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (group_id, session_id)
);
`;

const openGroupsDb = (dbPath: string): DatabaseSync => {
  ensureDbDir(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
};

const groupShape = {
  id: "string",
  name: "string | null",
  created_at: "string",
} as const;

const GroupRow = type(groupShape);

type GroupRow = typeof GroupRow.infer;

const GroupCols = Object.keys(groupShape).join(", ");

const MemberRow = type({
  group_id: "string",
  session_id: "string",
});

const mapGroup = (row: GroupRow): SessionGroup => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
});

const createGroup = (
  db: DatabaseSync,
  input: GroupInput = {},
): SessionGroup => {
  const id = randomUUID();
  const name = input.name?.trim() ?? "";
  db.prepare("INSERT INTO session_groups (id, name) VALUES (?, ?)").run(
    id,
    name === "" ? null : name,
  );
  const created = getGroup(db, id);
  if (created === undefined) throw new Error("failed to read back group");
  return created;
};

const getGroup = (db: DatabaseSync, id: string): SessionGroup | undefined => {
  const row = validate(
    GroupRow,
    db.prepare(`SELECT ${GroupCols} FROM session_groups WHERE id = ?`).get(id),
  );
  return row === undefined ? undefined : mapGroup(row);
};

const renameGroup = (db: DatabaseSync, id: string, rawName: string): void => {
  const name = rawName.trim();
  db.prepare("UPDATE session_groups SET name = ? WHERE id = ?").run(
    name === "" ? null : name,
    id,
  );
};

// Deletes a group and its members in one transaction.
const deleteGroup = (db: DatabaseSync, id: string): void => {
  transaction(db, () => {
    db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
    db.prepare("DELETE FROM session_groups WHERE id = ?").run(id);
  });
};

// Ensures single-group membership: removes the session from any existing
// group, then adds it to the target.  Idempotent if already a member.
const addMember = (
  db: DatabaseSync,
  groupId: string,
  sessionId: string,
): void => {
  transaction(db, () => {
    db.prepare("DELETE FROM group_members WHERE session_id = ?").run(sessionId);
    db.prepare(
      "INSERT INTO group_members (group_id, session_id) VALUES (?, ?)",
    ).run(groupId, sessionId);
  });
};

// Removes a session from whatever group it belongs to.
const removeMember = (db: DatabaseSync, sessionId: string): void => {
  db.prepare("DELETE FROM group_members WHERE session_id = ?").run(sessionId);
};

// Returns the group id a session belongs to, or undefined when ungrouped.
const groupIdOf = (db: DatabaseSync, sessionId: string): string | undefined => {
  const row = validate(
    type({ group_id: "string" }),
    db
      .prepare("SELECT group_id FROM group_members WHERE session_id = ?")
      .get(sessionId),
  );
  return row?.group_id;
};

// Every group with its member session ids, in creation order.  The member ids
// preserve insertion order so callers can reorder by recency externally.
const listGroups = (db: DatabaseSync): GroupWithMembers[] => {
  const groups = validateAll(
    GroupRow,
    db
      .prepare(`SELECT ${GroupCols} FROM session_groups ORDER BY created_at`)
      .all(),
  );
  const members = validateAll(
    MemberRow,
    db.prepare("SELECT group_id, session_id FROM group_members").all(),
  );
  const byGroup = new Map<string, string[]>();
  for (const m of members) {
    const list = byGroup.get(m.group_id) ?? [];
    list.push(m.session_id);
    byGroup.set(m.group_id, list);
  }
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    memberIds: byGroup.get(g.id) ?? [],
  }));
};

// Dissolves any group whose visible (non-archived) membership has fallen to
// one or zero — the governing rule applied at the data layer after an explicit
// drag-out.  `visibleSessionIds` is the set of session ids currently shown in
// the sidebar (goose DB, non-archived).  Groups that drop below the threshold
// via archiving are NOT dissolved here — their membership is retained so an
// un-archive restores the group; they simply stop rendering.
const pruneBelowThreshold = (
  db: DatabaseSync,
  visibleSessionIds: Set<string>,
  excludeGroupIds: ReadonlySet<string> = new Set(),
): void => {
  for (const group of listGroups(db)) {
    if (excludeGroupIds.has(group.id)) continue;
    const visible = group.memberIds.filter((id) => visibleSessionIds.has(id));
    if (visible.length <= 1) deleteGroup(db, group.id);
  }
};

// Cleans up groups that have no members (e.g. after all members were dragged
// out).  Called after membership mutations.
const pruneEmptyGroups = (db: DatabaseSync): void => {
  db.exec(
    `DELETE FROM session_groups
       WHERE id NOT IN (SELECT DISTINCT group_id FROM group_members)`,
  );
};

// Removes all groups and memberships — used by tests.
const clearGroups = (db: DatabaseSync): void => {
  transaction(db, () => {
    db.exec("DELETE FROM group_members");
    db.exec("DELETE FROM session_groups");
  });
};

export type { GroupInput, GroupWithMembers, SessionGroup };
export {
  addMember,
  clearGroups,
  createGroup,
  deleteGroup,
  getGroup,
  groupIdOf,
  listGroups,
  openGroupsDb,
  pruneBelowThreshold,
  pruneEmptyGroups,
  removeMember,
  renameGroup,
  resolveGroupsDbPath,
};
