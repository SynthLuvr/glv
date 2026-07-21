import type { DatabaseSync } from "node:sqlite";

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

export { placeholders, transaction };
