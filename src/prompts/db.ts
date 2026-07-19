import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { defineTable, placeholders, transaction } from "../query.js";

// A reusable prompt the user can fill the textarea with or run directly. Lives
// in a glv-owned, read-write database (never the goose sessions DB, which is
// opened read-only) so the library can persist alongside goose safely.
type SavedPrompt = {
  id: string;
  title: string;
  body: string;
  category: string | null;
  sortOrder: number;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type PromptInput = {
  title: string;
  body: string;
  category?: string;
};

// "order" is the default manual ordering (sort_order then recency);
// "usage" surfaces frequently-run prompts first for the power-user toggle.
type PromptSort = "order" | "usage";

const defaultPromptsDbPath = (): string =>
  join(homedir(), ".local", "share", "glv", "prompts.db");

const resolvePromptsDbPath = (override?: string): string =>
  override ?? process.env.GLV_PROMPTS_DB ?? defaultPromptsDbPath();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS saved_prompts (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  category     TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  usage_count  INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const openPromptsDb = (dbPath: string): DatabaseSync => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
};

const promptShape = {
  id: "string",
  title: "string",
  body: "string",
  category: "string | null",
  sort_order: "number",
  usage_count: "number",
  last_used_at: "string | null",
  created_at: "string",
  updated_at: "string",
} as const;

const PromptRow = type(promptShape);

type PromptRow = typeof PromptRow.infer;

const savedPrompts = defineTable({
  table: "saved_prompts",
  columns: Object.keys(promptShape),
  schema: PromptRow,
});

const categories = defineTable({
  table: "saved_prompts",
  columns: ["category"],
  schema: type({ category: "string" }),
});

const mapPrompt = (row: PromptRow): SavedPrompt => ({
  id: row.id,
  title: row.title,
  body: row.body,
  category: row.category,
  sortOrder: row.sort_order,
  usageCount: row.usage_count,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// An empty/whitespace category is stored as NULL so it is excluded from the
// category datalist and never rendered as an empty tag.
const normalizeCategory = (category: string | undefined): string | null => {
  const trimmed = (category ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

const listPrompts = (
  db: DatabaseSync,
  sort: PromptSort = "order",
): SavedPrompt[] =>
  savedPrompts
    .all(db, {
      orderBy:
        sort === "usage"
          ? "usage_count DESC, last_used_at DESC NULLS LAST"
          : "sort_order ASC, last_used_at DESC NULLS LAST",
    })
    .map(mapPrompt);

const getPrompt = (db: DatabaseSync, id: string): SavedPrompt | undefined => {
  const row = savedPrompts.one(db, { where: "id = ?", params: [id] });
  return row === undefined ? undefined : mapPrompt(row);
};

const createPrompt = (db: DatabaseSync, input: PromptInput): SavedPrompt => {
  const id = randomUUID();
  const category = normalizeCategory(input.category);
  savedPrompts.insert(db, {
    columns: ["id", "title", "body", "category"],
    values: placeholders(4),
    params: [id, input.title.trim(), input.body, category],
  });
  const created = getPrompt(db, id);
  if (created === undefined)
    throw new Error("failed to read back saved prompt");
  return created;
};

const updatePrompt = (
  db: DatabaseSync,
  id: string,
  input: PromptInput,
): void => {
  const category = normalizeCategory(input.category);
  savedPrompts.update(db, {
    set: "title = ?, body = ?, category = ?, updated_at = datetime('now')",
    where: "id = ?",
    params: [input.title.trim(), input.body, category, id],
  });
};

const deletePrompt = (db: DatabaseSync, id: string): void => {
  savedPrompts.remove(db, { where: "id = ?", params: [id] });
};

// Bumped by the run flow only, so edits never touch usage stats.
const bumpUsage = (db: DatabaseSync, id: string): void => {
  savedPrompts.update(db, {
    set: "usage_count = usage_count + 1, last_used_at = datetime('now')",
    where: "id = ?",
    params: [id],
  });
};

// Persists a full manual ordering in one transaction. Each id receives a
// monotonically increasing sort_order matching its position in `ids`, so
// drag-to-reorder stays consistent across reloads.
const reorderPrompts = (db: DatabaseSync, ids: string[]): void => {
  transaction(db, () => {
    ids.forEach((id, index) => {
      savedPrompts.update(db, {
        set: "sort_order = ?",
        where: "id = ?",
        params: [index, id],
      });
    });
  });
};

const listCategories = (db: DatabaseSync): string[] => {
  const rows = categories.all(db, {
    where: "category IS NOT NULL",
    orderBy: "category",
  });
  return [...new Set(rows.map((row) => row.category))];
};

export type { PromptInput, PromptSort, SavedPrompt };
export {
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
};
