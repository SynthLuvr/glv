import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { namespacedId } from "./agents.js";
import { openAuthDb } from "./auth/db.js";
import { openCronDb } from "./cron-jobs.js";
import { dataRoot } from "./db-path.js";
import { openGroupsDb } from "./groups/db.js";
import { openPromptsDb } from "./prompts/db.js";
import { openMetaDb } from "./session-meta.js";

// The one-time migration from the per-flavor data directories
// (~/.local/share/glv-goose, glv-claude) into the unified glv directory:
// prompts, groups, cron rows, the auth database, uploads and temp dirs.
// Rows whose ids name sessions (group members, cron tags, upload/temp
// markers, claude's meta sidecar) are re-keyed with their flavor's id
// prefix so every persisted row is self-describing in the merged id
// space. Conflicts resolve in favor of goose, matching the config-file
// migration precedent.
//
// Legacy directories are left in place — renamed `<name>.migrated`,
// never deleted — and the rename is the adoption marker: idempotent by
// construction, and a re-created legacy directory (a straggler binary
// still writing) is adopted again on the next start.

const MIGRATED_SUFFIX = ".migrated";

// One legacy data directory to adopt from.
type LegacyDir = {
  /** The agent whose rows these are ("goose", "claude"). */
  readonly agent: string;
  /** The legacy directory name ("glv-goose", "glv-claude"). */
  readonly dataDirName: string;
};

// Where the unified server keeps its databases; every path is one the
// caller resolved through the same helpers the server opens with, so an
// override target is migrated into exactly what serve will read.
type MigrationTargets = {
  readonly authDb: string;
  readonly promptsDb: string;
  readonly groupsDb: string;
  readonly cronDb: string;
  /** claude's viewer-meta sidecar under the unified dir. */
  readonly claudeMetaDb?: string;
  /** The unified uploads root (marker-tagged dirs move here). */
  readonly uploadsDir: string;
  /** The unified temp working-dir root (marker-tagged dirs move here). */
  readonly tempDir: string;
};

type MigrationOutcome = {
  /** Legacy directories adopted, by data dir name. */
  readonly adopted: readonly string[];
  /** Human-readable notes (retired credentials, skipped pieces). */
  readonly notices: readonly string[];
};

// A legacy directory that exists and has not been adopted yet.
const pendingDir = (legacy: LegacyDir): string | undefined => {
  const dir = join(dataRoot(), legacy.dataDirName);
  return existsSync(dir) ? dir : undefined;
};

// Renames the legacy directory out of the way. A straggler legacy binary
// may have re-created its directory after an earlier adoption; the fresh
// copy is adopted again, so the previous marker moves aside first.
const retireDir = (dir: string): void => {
  const retired = `${dir}${MIGRATED_SUFFIX}`;
  if (existsSync(retired)) renameSync(retired, `${retired}-${Date.now()}`);
  renameSync(dir, retired);
};

// Column names of a table in declaration order; the legacy and unified
// schemas are glv-owned and identical for these tables, so the shared
// column list is the intersection both databases actually declare.
const columnsOf = (db: DatabaseSync, table: string): string[] => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  const names: string[] = [];
  for (const row of rows) {
    const name = row.name;
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names;
};

// Copies every row of `table` from the legacy database into the target,
// ignoring rows whose primary key already exists (goose landed first).
// `rekey` rewrites one column's value on the way through; `extra` pins
// additional column values on inserted rows (the cron agent column).
const copyTable = (
  from: DatabaseSync,
  to: DatabaseSync,
  table: string,
  opts: {
    rekey?: {
      readonly column: string;
      readonly via: (value: string) => string;
    };
    extra?: Readonly<Record<string, string>>;
  } = {},
): number => {
  const fromCols = columnsOf(from, table);
  const toCols = columnsOf(to, table);
  const shared = fromCols.filter((col) => toCols.includes(col));
  if (shared.length === 0) return 0;
  const insertCols = [...shared, ...Object.keys(opts.extra ?? {})];
  const marks = insertCols.map(() => "?").join(", ");
  const insert = to.prepare(
    `INSERT OR IGNORE INTO ${table} (${insertCols.join(", ")}) ` +
      `VALUES (${marks})`,
  );
  const select = from.prepare(`SELECT ${shared.join(", ")} FROM ${table}`);
  let copied = 0;
  for (const row of select.all()) {
    const values: SQLInputValue[] = insertCols.map((col) => {
      if (opts.extra !== undefined && col in opts.extra) return opts.extra[col];
      const value = row[col];
      if (
        opts.rekey !== undefined &&
        col === opts.rekey.column &&
        typeof value === "string"
      )
        return opts.rekey.via(value);
      return value === undefined ? null : value;
    });
    copied += Number(insert.run(...values).changes);
  }
  return copied;
};

// Opens a legacy database read-only for one copying pass, closing it
// after; a missing file skips the pass.
const withLegacyDb = (
  dir: string,
  name: string,
  copy: (db: DatabaseSync) => void,
): void => {
  const path = join(dir, name);
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    copy(db);
  } finally {
    db.close();
  }
};

// The marker file uploads and temp dirs carry (uploads.ts spells the
// same name; re-declared so this module owns no server dependency).
const SESSION_MARKER = ".glv-session-id";

// Moves one marker-tagged directory into the unified base, rewriting the
// marker to the namespaced session id.
const moveTaggedDir = (
  dir: string,
  name: string,
  toBase: string,
  agent: string,
): void => {
  const markerPath = join(dir, SESSION_MARKER);
  if (!existsSync(markerPath)) return;
  const marker = readFileSync(markerPath, "utf-8").trim();
  if (marker === "") return;
  // An already-namespaced marker ids a session the merged product
  // itself tagged; re-keying would double-prefix, so keep it.
  const nextMarker = marker.includes(":")
    ? marker
    : namespacedId(agent, marker);
  let target = join(toBase, name);
  if (existsSync(target)) target = join(toBase, `${name}-${Date.now()}`);
  renameSync(dir, target);
  writeFileSync(join(target, SESSION_MARKER), nextMarker);
};

// Moves every tagged directory under a legacy uploads/tmp base into the
// unified base. Untagged directories (failed attempts) stay behind in
// the retired legacy directory — nothing references them.
const moveTaggedDirs = (
  fromBase: string,
  toBase: string,
  agent: string,
  notices: string[],
): void => {
  if (!existsSync(fromBase)) return;
  mkdirSync(toBase, { recursive: true });
  for (const entry of readdirSync(fromBase, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(fromBase, entry.name);
    try {
      moveTaggedDir(dir, entry.name, toBase, agent);
    } catch (err) {
      notices.push(
        `could not move ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
};

// Runs the whole adoption. Order matters: goose first everywhere, so
// conflicts resolve in its favor.
const runLegacyMigration = (
  flavors: readonly LegacyDir[],
  targets: MigrationTargets,
): MigrationOutcome => {
  const adopted: string[] = [];
  const notices: string[] = [];
  const pending = flavors
    .map((legacy) => ({ legacy, dir: pendingDir(legacy) }))
    .filter(
      (entry): entry is { legacy: LegacyDir; dir: string } =>
        entry.dir !== undefined,
    );
  if (pending.length === 0) return { adopted, notices };

  // Opened through each store's own open so the target schemas exist
  // before rows copy into them.
  const promptsDb = openPromptsDb(targets.promptsDb);
  const groupsDb = openGroupsDb(targets.groupsDb);
  const cronDb = openCronDb(targets.cronDb);
  try {
    for (const { legacy, dir } of pending) {
      const prefix = (id: string): string => namespacedId(legacy.agent, id);

      withLegacyDb(dir, "prompts.db", (db) =>
        copyTable(db, promptsDb, "saved_prompts"),
      );

      withLegacyDb(dir, "groups.db", (db) => {
        copyTable(db, groupsDb, "session_groups");
        copyTable(db, groupsDb, "group_members", {
          rekey: { column: "session_id", via: prefix },
        });
      });

      withLegacyDb(dir, "cron.db", (db) => {
        copyTable(db, cronDb, "cron_jobs", { extra: { agent: legacy.agent } });
        copyTable(db, cronDb, "cron_sessions", {
          rekey: { column: "session_id", via: prefix },
        });
      });

      const metaTarget = targets.claudeMetaDb;
      if (legacy.agent === "claude" && metaTarget !== undefined)
        withLegacyDb(dir, "meta.db", (db) => {
          const meta = openMetaDb(metaTarget);
          try {
            copyTable(db, meta, "session_meta", {
              rekey: { column: "id", via: prefix },
            });
          } finally {
            meta.close();
          }
        });

      moveTaggedDirs(
        join(dir, "uploads"),
        targets.uploadsDir,
        legacy.agent,
        notices,
      );
      moveTaggedDirs(join(dir, "tmp"), targets.tempDir, legacy.agent, notices);

      adopted.push(legacy.dataDirName);
    }

    adoptAuthDb(pending, targets, notices);
  } finally {
    promptsDb.close();
    groupsDb.close();
    cronDb.close();
  }

  for (const { dir } of pending) retireDir(dir);
  return { adopted, notices };
};

// Auth: adopt a legacy auth database wholesale when exactly one of the
// pending flavors has an owner — the common single-flavor user keeps
// their passkey with zero action. When both have owners, goose's wins
// and the claude credential is retired with a notice (re-enroll via
// /auth/devices); merging two independent WebAuthn credential sets
// under one single-occupancy user is not worth the ambiguity. A unified
// database that already has an owner is never overwritten.
const adoptAuthDb = (
  pending: readonly { legacy: LegacyDir; dir: string }[],
  targets: MigrationTargets,
  notices: string[],
): void => {
  const auth = openAuthDb(targets.authDb);
  try {
    const owned = (dir: string): boolean => {
      const path = join(dir, "auth.db");
      if (!existsSync(path)) return false;
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const row = db.prepare("SELECT 1 FROM users LIMIT 1").get();
        return row !== undefined;
      } finally {
        db.close();
      }
    };
    if (auth.prepare("SELECT 1 FROM users LIMIT 1").get() !== undefined) return;
    const owners = pending.filter((entry) => owned(entry.dir));
    if (owners.length === 0) return;
    const winner =
      owners.length > 1
        ? (owners.find((entry) => entry.legacy.agent === "goose") ?? owners[0])
        : owners[0];
    for (const other of owners)
      if (other !== winner)
        notices.push(
          `the ${other.legacy.agent} passkey was retired — re-enroll it via /auth/devices`,
        );
    const legacyAuth = new DatabaseSync(join(winner.dir, "auth.db"), {
      readOnly: true,
    });
    try {
      for (const table of [
        "users",
        "credentials",
        "sessions",
        "enrollment_tokens",
      ])
        copyTable(legacyAuth, auth, table);
    } finally {
      legacyAuth.close();
    }
  } finally {
    auth.close();
  }
};

export type { LegacyDir, MigrationOutcome, MigrationTargets };
export { runLegacyMigration };
