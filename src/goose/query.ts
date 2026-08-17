import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";

type Validator<T> = (data: unknown) => T | type.errors;

const validate = <T>(schema: Validator<T>, row: unknown): T | undefined => {
  const result = schema(row);
  return result instanceof type.errors ? undefined : result;
};

const validateAll = <T>(schema: Validator<T>, rows: unknown[]): T[] =>
  rows
    .map((row) => validate(schema, row))
    .filter((row): row is T => row !== undefined);

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

export { placeholders, transaction, validate, validateAll };
