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

const placeholders = (n: number): string =>
  Array.from({ length: n }, () => "?").join(", ");

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

const validate = <T>(schema: Validator<T>, row: unknown): T | undefined => {
  const result = schema(row);
  if (result instanceof type.errors) return undefined;
  return result;
};

const whereClause = (options: MutateOptions): string =>
  options.where ? ` WHERE ${options.where}` : "";

// SQL fragments (where / set / values) stay raw strings bound by params in
// order, so SQLite idioms like datetime('now') stay readable instead of going
// through a query DSL. Every returned row is validated and dropped on drift.
const defineTable = <T>(opts: {
  table: string;
  columns: readonly string[];
  schema: Validator<T>;
}): TableDescriptor<T> => {
  const cols = opts.columns.join(", ");
  const { table, schema } = opts;

  const all = (db: DatabaseSync, options: SelectOptions = {}): T[] => {
    const parts = [`SELECT ${cols} FROM ${table}`];
    if (options.where) parts.push(`WHERE ${options.where}`);
    if (options.orderBy) parts.push(`ORDER BY ${options.orderBy}`);
    if (options.limit !== undefined) parts.push("LIMIT ?");

    const params = [...(options.params ?? [])];
    if (options.limit !== undefined) params.push(options.limit);

    return db
      .prepare(parts.join(" "))
      .all(...params)
      .map((row) => validate(schema, row))
      .filter((r): r is T => r !== undefined);
  };

  const one = (
    db: DatabaseSync,
    options: MutateOptions = {},
  ): T | undefined => {
    const row = db
      .prepare(`SELECT ${cols} FROM ${table}${whereClause(options)}`)
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
    db.prepare(`UPDATE ${table} SET ${options.set}${whereClause(options)}`).run(
      ...(options.params ?? []),
    );
  };

  const remove = (db: DatabaseSync, options: MutateOptions = {}): void => {
    db.prepare(`DELETE FROM ${table}${whereClause(options)}`).run(
      ...(options.params ?? []),
    );
  };

  const count = (db: DatabaseSync, options: MutateOptions = {}): number => {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table}${whereClause(options)}`)
      .get(...(options.params ?? []));
    return typeof row?.n === "number" ? row.n : 0;
  };

  return { all, one, insert, update, remove, count };
};

export { defineTable, placeholders, transaction };
