import { describe, expect, it } from "vitest";
import type { SessionRow } from "../db.js";
import type { GroupWithMembers } from "../groups/db.js";
import { buildEntries, DEFAULT_GROUP_NAME } from "../groups/model.js";

const makeSession = (id: string, updated: string): SessionRow => ({
  id,
  name: id,
  user_set_name: null,
  description: "",
  session_type: "user",
  working_dir: "/tmp",
  created_at: "2026-01-01 00:00:00",
  updated_at: updated,
  total_tokens: null,
  provider_name: null,
  archived_at: null,
});

const mkGroup = (
  id: string,
  memberIds: string[],
  name: string | null = null,
): GroupWithMembers => ({ id, name, memberIds });

describe("buildEntries — no groups", () => {
  it("returns all sessions as flat entries when groups is undefined", () => {
    const sessions = [
      makeSession("a", "2026-01-03"),
      makeSession("b", "2026-01-02"),
    ];
    const entries = buildEntries(sessions, undefined);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("session");
    expect(entries[1]?.kind).toBe("session");
  });

  it("returns all sessions as flat entries when groups is empty", () => {
    const sessions = [makeSession("a", "2026-01-03")];
    const entries = buildEntries(sessions, []);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("session");
  });
});

describe("buildEntries — grouping", () => {
  it("renders a group when ≥ 2 visible members", () => {
    const sessions = [
      makeSession("a", "2026-01-03"),
      makeSession("b", "2026-01-02"),
      makeSession("c", "2026-01-01"),
    ];
    const groups = [mkGroup("g1", ["a", "b"])];
    const entries = buildEntries(sessions, groups);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("group");
    if (entries[0]?.kind === "group") {
      expect(entries[0].groupName).toBe(DEFAULT_GROUP_NAME);
      expect(entries[0].memberCount).toBe(2);
      expect(entries[0].members.map((m) => m.id)).toEqual(["a", "b"]);
    }
    expect(entries[1]?.kind).toBe("session");
  });

  it("uses a custom group name when provided", () => {
    const sessions = [
      makeSession("a", "2026-01-02"),
      makeSession("b", "2026-01-01"),
    ];
    const entries = buildEntries(sessions, [
      mkGroup("g1", ["a", "b"], "Refactor"),
    ]);
    if (entries[0]?.kind === "group")
      expect(entries[0].groupName).toBe("Refactor");
  });

  it("does NOT render a group with only 1 visible member", () => {
    // "c" is a member but not in the session list (archived/filtered out)
    const sessions = [
      makeSession("a", "2026-01-02"),
      makeSession("b", "2026-01-01"),
    ];
    const groups = [mkGroup("g1", ["a", "c"])];
    const entries = buildEntries(sessions, groups);
    // "a" falls through as flat because its group has <2 visible members
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === "session")).toBe(true);
  });

  it("orders members within a group by recency", () => {
    const sessions = [
      makeSession("newest", "2026-01-05"),
      makeSession("middle", "2026-01-03"),
      makeSession("oldest", "2026-01-01"),
    ];
    const entries = buildEntries(sessions, [
      mkGroup("g", ["oldest", "middle", "newest"]),
    ]);
    if (entries[0]?.kind === "group")
      expect(entries[0].members.map((m) => m.id)).toEqual([
        "newest",
        "middle",
        "oldest",
      ]);
  });

  it("positions a group by its newest member's recency", () => {
    const sessions = [
      makeSession("ungrouped-fresh", "2026-01-10"),
      makeSession("group-newest", "2026-01-08"),
      makeSession("ungrouped-old", "2026-01-02"),
      makeSession("group-oldest", "2026-01-01"),
    ];
    const entries = buildEntries(sessions, [
      mkGroup("g", ["group-oldest", "group-newest"]),
    ]);
    // Order: ungrouped-fresh (10th), group (8th), ungrouped-old (2nd)
    expect(entries).toHaveLength(3);
    expect(entries[0]?.kind).toBe("session");
    expect(entries[1]?.kind).toBe("group");
    expect(entries[2]?.kind).toBe("session");
  });

  it("handles multiple groups alongside flat sessions", () => {
    const sessions = [
      makeSession("s1", "2026-01-05"),
      makeSession("s2", "2026-01-04"),
      makeSession("s3", "2026-01-03"),
      makeSession("s4", "2026-01-02"),
      makeSession("s5", "2026-01-01"),
    ];
    const groups = [mkGroup("g1", ["s1", "s2"]), mkGroup("g2", ["s4", "s5"])];
    const entries = buildEntries(sessions, groups);
    // g1 (s1+s2, newest=5th), s3 (3rd), g2 (s4+s5, newest=2nd)
    expect(entries).toHaveLength(3);
    expect(entries[0]?.kind).toBe("group");
    expect(entries[1]?.kind).toBe("session");
    expect(entries[2]?.kind).toBe("group");
  });
});
