import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";

type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;

type Validator<T> = (data: unknown) => T | type.errors;

type SelectOptions = {
  where?: string;
  params?: readonly SqlValue[];
  orderBy?: string;
  limit?: number;
};

type MutateOptions = {
  where?: string;
  params?: readonly SqlValue[];
};

type InsertOptions = {
  columns: readonly string[];
  values: string;
  params?: readonly SqlValue[];
};

type TableDescriptor<T> = {
  all: (db: DatabaseSync, options?: SelectOptions) => T[];
  one: (db: DatabaseSync, options?: MutateOptions) => T | undefined;
  insert: (db: DatabaseSync, options: InsertOptions) => void;
  update: (db: DatabaseSync, options: { set: string } & MutateOptions) => void;
  remove: (db: DatabaseSync, options?: MutateOptions) => void;
  count: (db: DatabaseSync, options?: MutateOptions) => number;
};

// Builds a "?, ?, ?" list for IN (...) clauses and INSERT VALUES fragments.
const placeholders = (n: number): string =>
  Array.from({ length: n }, () => "?").join(", ");

// Runs fn inside a transaction, rolling back on error.
const transaction = <T>(db: DatabaseSync, fn: () => T): T => {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

// Validates a row and drops it (returns undefined) when it drifts from the
// schema. Mirrors Papr's strict mode for a DB whose shape we don't control.
const validate = <T>(schema: Validator<T>, row: unknown): T | undefined => {
  const result = schema(row);
  if (result instanceof type.errors) return undefined;
  return result;
};

// Describes a table once: its name, the columns to project, and an arktype
// schema used to validate every returned row. Returns typed query helpers.
//
// SQL fragments (where / set / values) stay raw strings with ? placeholders
// bound by params in order. This keeps SQLite idioms like
// datetime('now') readable instead of forcing them through a query DSL.
const defineTable = <T>(opts: {
  table: string;
  columns: readonly string[];
  schema: Validator<T>;
}): TableDescriptor<T> => {
  const cols = opts.columns.join(", ");
  const { table, schema } = opts;

  const all = (db: DatabaseSync, options: SelectOptions = {}): T[] => {
    const clauses = [
      `SELECT ${cols} FROM ${table}`,
      options.where ? `WHERE ${options.where}` : "",
      options.orderBy ? `ORDER BY ${options.orderBy}` : "",
      options.limit !== undefined ? "LIMIT ?" : "",
    ];
    const sql = clauses.filter((s) => s !== "").join(" ");
    const params = [...(options.params ?? [])];
    if (options.limit !== undefined) params.push(options.limit);
    return db
      .prepare(sql)
      .all(...params)
      .map((row) => validate(schema, row))
      .filter((r): r is T => r !== undefined);
  };

  const one = (
    db: DatabaseSync,
    options: MutateOptions = {},
  ): T | undefined => {
    const tail = options.where ? ` WHERE ${options.where}` : "";
    const row = db
      .prepare(`SELECT ${cols} FROM ${table}${tail}`)
      .get(...(options.params ?? []));
    if (row === undefined) return undefined;
    return validate(schema, row);
  };

  const insert = (db: DatabaseSync, options: InsertOptions): void => {
    const sql = `INSERT INTO ${table} (${options.columns.join(
      ", ",
    )}) VALUES (${options.values})`;
    db.prepare(sql).run(...(options.params ?? []));
  };

  const update = (
    db: DatabaseSync,
    options: { set: string } & MutateOptions,
  ): void => {
    const tail = options.where ? ` WHERE ${options.where}` : "";
    db.prepare(`UPDATE ${table} SET ${options.set}${tail}`).run(
      ...(options.params ?? []),
    );
  };

  const remove = (db: DatabaseSync, options: MutateOptions = {}): void => {
    const tail = options.where ? ` WHERE ${options.where}` : "";
    db.prepare(`DELETE FROM ${table}${tail}`).run(...(options.params ?? []));
  };

  const count = (db: DatabaseSync, options: MutateOptions = {}): number => {
    const tail = options.where ? ` WHERE ${options.where}` : "";
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table}${tail}`)
      .get(...(options.params ?? []));
    const n = row?.n;
    if (typeof n !== "number") return 0;
    return n;
  };

  return { all, one, insert, update, remove, count };
};

export type { InsertOptions, MutateOptions, SelectOptions, SqlValue };
export { defineTable, placeholders, transaction };
