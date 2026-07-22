import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember,
  clearGroups,
  createGroup,
  deleteGroup,
  getGroup,
  groupIdOf,
  listGroups,
  openGroupsDb,
  pruneBelowThreshold,
  removeMember,
  renameGroup,
  resolveGroupsDbPath,
} from "../groups/db.js";

describe("fresh groups database", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-groups-fresh-"));
    db = openGroupsDb(join(dir, "groups.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the session_groups and group_members tables", () => {
    const isNameRow = (v: unknown): v is { name: string } =>
      typeof v === "object" &&
      v !== null &&
      "name" in v &&
      typeof v.name === "string";
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .filter(isNameRow);
    expect(tables.map((t) => t.name)).toEqual([
      "group_members",
      "session_groups",
    ]);
  });

  it("starts empty", () => {
    expect(listGroups(db)).toEqual([]);
  });
});

describe("group CRUD", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-groups-crud-"));
    db = openGroupsDb(join(dir, "groups.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a group with a null name by default", () => {
    const group = createGroup(db);
    expect(group.id).toBeTruthy();
    expect(group.name).toBeNull();
    expect(getGroup(db, group.id)?.id).toBe(group.id);
  });

  it("creates a group with a provided name", () => {
    const group = createGroup(db, { name: "Refactor" });
    expect(group.name).toBe("Refactor");
  });

  it("trims whitespace from the name", () => {
    const group = createGroup(db, { name: "  spaced  " });
    expect(group.name).toBe("spaced");
  });

  it("renames a group", () => {
    const group = createGroup(db);
    renameGroup(db, group.id, "Updated");
    expect(getGroup(db, group.id)?.name).toBe("Updated");
  });

  it("clears the name back to null on blank", () => {
    const group = createGroup(db, { name: "Temp" });
    renameGroup(db, group.id, "   ");
    expect(getGroup(db, group.id)?.name).toBeNull();
  });

  it("returns undefined for an unknown id", () => {
    expect(getGroup(db, "nope")).toBeUndefined();
  });
});

describe("membership", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-groups-members-"));
    db = openGroupsDb(join(dir, "groups.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds and looks up a member", () => {
    const group = createGroup(db);
    addMember(db, group.id, "alpha");
    expect(groupIdOf(db, "alpha")).toBe(group.id);
  });

  it("enforces single-group membership (moving removes from old)", () => {
    const g1 = createGroup(db);
    const g2 = createGroup(db);
    addMember(db, g1.id, "beta");
    addMember(db, g2.id, "beta");
    expect(groupIdOf(db, "beta")).toBe(g2.id);
    // g1 should no longer have beta
    const g1Members = listGroups(db).find((g) => g.id === g1.id);
    expect(g1Members?.memberIds).not.toContain("beta");
  });

  it("is idempotent when re-adding to the same group", () => {
    const group = createGroup(db);
    addMember(db, group.id, "gamma");
    addMember(db, group.id, "gamma");
    const g = listGroups(db).find((x) => x.id === group.id);
    expect(g?.memberIds).toEqual(["gamma"]);
  });

  it("removes a member", () => {
    const group = createGroup(db);
    addMember(db, group.id, "delta");
    removeMember(db, "delta");
    expect(groupIdOf(db, "delta")).toBeUndefined();
  });

  it("removeMember is a no-op for an ungrouped session", () => {
    expect(() => removeMember(db, "ungrouped")).not.toThrow();
  });
});

describe("listGroups", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-groups-list-"));
    db = openGroupsDb(join(dir, "groups.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns groups with their member ids", () => {
    const g = createGroup(db, { name: "Team" });
    addMember(db, g.id, "a");
    addMember(db, g.id, "b");
    const groups = listGroups(db);
    const found = groups.find((x) => x.id === g.id);
    expect(found?.name).toBe("Team");
    expect(found?.memberIds).toEqual(["a", "b"]);
  });
});

describe("dissolve and prune", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-groups-prune-"));
    db = openGroupsDb(join(dir, "groups.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deleteGroup removes the group and all its members", () => {
    const g = createGroup(db);
    addMember(db, g.id, "x");
    addMember(db, g.id, "y");
    deleteGroup(db, g.id);
    expect(getGroup(db, g.id)).toBeUndefined();
    expect(groupIdOf(db, "x")).toBeUndefined();
    expect(groupIdOf(db, "y")).toBeUndefined();
  });

  it("pruneBelowThreshold dissolves groups with 1 visible member", () => {
    const g = createGroup(db);
    addMember(db, g.id, "p1");
    addMember(db, g.id, "p2");
    // Both visible → survives
    pruneBelowThreshold(db, new Set(["p1", "p2"]));
    expect(getGroup(db, g.id)).toBeDefined();
    // Only one visible → dissolved
    pruneBelowThreshold(db, new Set(["p1"]));
    expect(getGroup(db, g.id)).toBeUndefined();
  });

  it("pruneBelowThreshold keeps groups with 2+ visible members", () => {
    const g = createGroup(db);
    addMember(db, g.id, "q1");
    addMember(db, g.id, "q2");
    addMember(db, g.id, "q3");
    pruneBelowThreshold(db, new Set(["q1", "q2"]));
    expect(getGroup(db, g.id)).toBeDefined();
    // q3 is invisible but q1+q2 keep the group alive
  });
});

describe("resolveGroupsDbPath", () => {
  const envName = "GLV_GROUPS_DB";

  it("prefers an explicit override", () => {
    const previous = process.env[envName];
    process.env[envName] = "/from/env";
    try {
      expect(resolveGroupsDbPath("/explicit")).toBe("/explicit");
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("falls back to the default", () => {
    const previous = process.env[envName];
    delete process.env[envName];
    try {
      expect(resolveGroupsDbPath()).toMatch(/groups\.db$/);
    } finally {
      if (previous !== undefined) process.env[envName] = previous;
    }
  });
});

describe("clearGroups (test helper)", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-groups-clear-"));
    db = openGroupsDb(join(dir, "groups.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes all groups and memberships", () => {
    const g = createGroup(db);
    addMember(db, g.id, "z");
    clearGroups(db);
    expect(listGroups(db)).toEqual([]);
  });
});
