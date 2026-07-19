import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bumpUsage,
  createPrompt,
  deletePrompt,
  getPrompt,
  listCategories,
  listPrompts,
  openPromptsDb,
  reorderPrompts,
  resolvePromptsDbPath,
  updatePrompt,
} from "../prompts/db.js";

describe("fresh prompts database", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-prompts-fresh-"));
    db = openPromptsDb(join(dir, "prompts.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the saved_prompts table", () => {
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
    expect(tables.map((t) => t.name)).toEqual(["saved_prompts"]);
  });

  it("starts empty with no prompts and no categories", () => {
    expect(listPrompts(db)).toEqual([]);
    expect(listCategories(db)).toEqual([]);
  });

  it("persists across reopens", () => {
    createPrompt(db, { title: "Persisted", body: "survive reopen" });
    db.close();
    db = openPromptsDb(join(dir, "prompts.db"));
    const prompts = listPrompts(db);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.title).toBe("Persisted");
  });
});

describe("prompt CRUD", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-prompts-crud-"));
    db = openPromptsDb(join(dir, "prompts.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates and retrieves a prompt by id", () => {
    const created = createPrompt(db, {
      title: "Fix failing tests",
      body: "Run the tests and fix every failure.",
      category: "tests",
    });
    expect(created.id).toBeTruthy();
    expect(created.category).toBe("tests");
    expect(created.usageCount).toBe(0);
    expect(created.lastUsedAt).toBeNull();
    expect(getPrompt(db, created.id)?.title).toBe("Fix failing tests");
  });

  it("stores a blank category as null", () => {
    const created = createPrompt(db, {
      title: "No category",
      body: "body",
      category: "   ",
    });
    expect(created.category).toBeNull();
  });

  it("trims the title on create", () => {
    const created = createPrompt(db, {
      title: "  spaced title  ",
      body: "body",
    });
    expect(created.title).toBe("spaced title");
  });

  it("updates title, body, and category", () => {
    const created = createPrompt(db, { title: "Old", body: "old body" });
    updatePrompt(db, created.id, {
      title: "New",
      body: "new body",
      category: "review",
    });
    const updated = getPrompt(db, created.id);
    expect(updated?.title).toBe("New");
    expect(updated?.body).toBe("new body");
    expect(updated?.category).toBe("review");
  });

  it("returns undefined for an unknown id", () => {
    expect(getPrompt(db, "does-not-exist")).toBeUndefined();
  });

  it("deletes a prompt", () => {
    const created = createPrompt(db, { title: "Delete me", body: "b" });
    deletePrompt(db, created.id);
    expect(getPrompt(db, created.id)).toBeUndefined();
  });
});

describe("usage tracking", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-prompts-usage-"));
    db = openPromptsDb(join(dir, "prompts.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("increments usage_count and stamps last_used_at", () => {
    const created = createPrompt(db, { title: "Run me", body: "b" });
    bumpUsage(db, created.id);
    bumpUsage(db, created.id);
    const prompt = getPrompt(db, created.id);
    expect(prompt?.usageCount).toBe(2);
    expect(prompt?.lastUsedAt).not.toBeNull();
  });

  it("is a no-op (no throw) for an unknown id", () => {
    expect(() => bumpUsage(db, "missing")).not.toThrow();
  });
});

describe("list ordering and categories", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-prompts-order-"));
    db = openPromptsDb(join(dir, "prompts.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces recently used prompts before never-used ones", () => {
    createPrompt(db, { title: "A", body: "a", category: "x" });
    const b = createPrompt(db, { title: "B", body: "b", category: "x" });
    // B was used more recently, so it must sort ahead of A (both share the
    // default sort_order; never-used A sinks to the back via NULLS LAST).
    bumpUsage(db, b.id);
    const titles = listPrompts(db).map((p) => p.title);
    expect(titles.indexOf("B")).toBeLessThan(titles.indexOf("A"));
  });

  it("lists distinct, non-null categories", () => {
    createPrompt(db, { title: "C", body: "c", category: "review" });
    createPrompt(db, { title: "D", body: "d", category: "review" });
    createPrompt(db, { title: "E", body: "e" });
    expect(listCategories(db)).toContain("review");
    expect(listCategories(db)).toContain("x");
    // No duplicates and no empties.
    expect(new Set(listCategories(db)).size).toBe(listCategories(db).length);
  });
});

describe("manual reordering and usage sort", () => {
  let db: DatabaseSync;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glv-prompts-reorder-"));
    db = openPromptsDb(join(dir, "prompts.db"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("assigns sort_order by position so the list mirrors the given order", () => {
    const a = createPrompt(db, { title: "A", body: "a" });
    const b = createPrompt(db, { title: "B", body: "b" });
    const c = createPrompt(db, { title: "C", body: "c" });
    reorderPrompts(db, [c.id, a.id, b.id]);
    expect(listPrompts(db).map((p) => p.title)).toEqual(["C", "A", "B"]);
  });

  it("is a no-op for an empty id list", () => {
    expect(() => reorderPrompts(db, [])).not.toThrow();
    expect(listPrompts(db).length).toBeGreaterThan(0);
  });

  it("'usage' sort surfaces the most-run prompt first", () => {
    const x = createPrompt(db, { title: "X", body: "x" });
    const y = createPrompt(db, { title: "Y", body: "y" });
    bumpUsage(db, y.id);
    bumpUsage(db, y.id);
    bumpUsage(db, x.id);
    const byUsage = listPrompts(db, "usage");
    // Y has the highest count, so it precedes X regardless of sort_order.
    expect(byUsage.findIndex((p) => p.title === "Y")).toBeLessThan(
      byUsage.findIndex((p) => p.title === "X"),
    );
  });
});

describe("resolvePromptsDbPath", () => {
  const envName = "GLV_PROMPTS_DB";

  it("prefers an explicit override over the env var and default", () => {
    const previous = process.env[envName];
    process.env[envName] = "/from/env";
    try {
      expect(resolvePromptsDbPath("/explicit")).toBe("/explicit");
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("falls back to the env var when no override is given", () => {
    const previous = process.env[envName];
    process.env[envName] = "/from/env";
    try {
      expect(resolvePromptsDbPath()).toBe("/from/env");
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it("falls back to the default when neither is set", () => {
    const previous = process.env[envName];
    delete process.env[envName];
    try {
      expect(resolvePromptsDbPath()).toBe(resolvePromptsDbPath());
      expect(resolvePromptsDbPath()).toMatch(/prompts\.db$/);
    } finally {
      if (previous !== undefined) process.env[envName] = previous;
    }
  });
});
