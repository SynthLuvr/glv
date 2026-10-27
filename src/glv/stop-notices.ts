import { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { openGlvDb, resolveDataPath } from "./db-path.js";
import { isRecord } from "./parse.js";
import type { RunHandle } from "./runner/index.js";

// Viewer-owned sidecar recording why a session's last run stopped early,
// keyed by the (namespaced) session id. Two shapes land here: provider
// refusals (usage limit with reset time, network outage), announced only
// on the agent's stdout and never in the rendered transcript, and
// run-terminal errors (crash exit, signal death, watchdog kill) carrying
// the exit verdict and a stderr tail. The in-memory run handle is
// evicted seconds after the process exits; this table makes either
// explanation survive a reload or a server restart. A clean settle or
// manual stop clears the row, so the notice always describes the *last*
// run. A second table, last_run, keeps the verdict of every settled run
// — clean finishes and user stops included — for the read API.
const STOP_NOTICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS stop_notices (
  session_id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// The last run's verdict for every session that has settled a run —
// finished and user-stopped included, not only the failures. The stop
// notice above is a UI affordance (shown until the session continues),
// so it cannot answer "how did the last run end?" over the API: a clean
// finish and a never-ran session both read as no notice. This table
// records the settle verdict itself, so the read API stays complete for
// orchestration long after the run handle's ~30 s registry window — and
// across a server restart. One row per session, always the latest run.
const LAST_RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS last_run (
  session_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  reason TEXT,
  ended_at TEXT NOT NULL
);
`;

const resolveStopNoticesDbPath = (
  dataDirName: string,
  override?: string,
): string =>
  resolveDataPath(
    override,
    "GLV_STOP_NOTICES_DB",
    dataDirName,
    "stop-notices.db",
  );

// glv owns the whole file and always creates the schema on open.
const openStopNoticesDb = (dbPath: string): DatabaseSync => {
  const db = openGlvDb(dbPath);
  db.exec(STOP_NOTICES_SCHEMA);
  db.exec(LAST_RUN_SCHEMA);
  return db;
};

const recordStopNotice = (
  db: DatabaseSync,
  sessionId: string,
  message: string,
): void => {
  db.prepare(
    "INSERT INTO stop_notices (session_id, message) VALUES (?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET " +
      "message = excluded.message, recorded_at = datetime('now')",
  ).run(sessionId, message);
};

// Every read failure (missing row, missing table, malformed value) reads
// as undefined, so a hand-edited database degrades to no notice.
const readStopNotice = (
  db: DatabaseSync,
  sessionId: string,
): string | undefined => {
  try {
    const row = db
      .prepare("SELECT message FROM stop_notices WHERE session_id = ?")
      .get(sessionId);
    return noticeMessage(row);
  } catch {
    return undefined;
  }
};

const noticeMessage = (row: unknown): string | undefined => {
  if (!isRecord(row)) return undefined;
  const { message } = row;
  return typeof message === "string" ? message : undefined;
};

const clearStopNotice = (db: DatabaseSync, sessionId: string): void => {
  db.prepare("DELETE FROM stop_notices WHERE session_id = ?").run(sessionId);
};

// ---- the last-run verdict ----

// How a settled run ended. "stopped_early" is the provider's doing (a
// usage limit, a network outage) — the run stopped but nothing crashed;
// "failed" is a crash verdict (non-zero exit, signal death, startup
// watchdog kill); "stopped" is the user's; "finished" settled cleanly.
// A schema, not a bare union, so the row reader below and the API's
// wire shape validate against the one definition.
const LastRunState = type("'finished'|'stopped'|'stopped_early'|'failed'");
type LastRunState = typeof LastRunState.infer;

// What the observer hands the recorder: the state plus the reason line
// (undefined for the two states that need none).
type LastRunOutcome = { state: LastRunState; reason: string | undefined };

// What a read returns: the outcome plus the settle instant (ISO UTC,
// taken when the run settled).
type LastRunRecord = LastRunOutcome & { endedAt: string };

// A stored last_run row, validated by ArkType at this boundary so the
// state union narrows without a cast. The readers treat a malformed row
// the way readStopNotice treats one — a hand-edited database degrades
// to no verdict.
const lastRunShape = {
  session_id: "string",
  state: LastRunState,
  reason: "string | null",
  ended_at: "string",
} as const;

const LastRunRow = type(lastRunShape);

// The column list every last_run statement names, derived from the
// shape so the two cannot drift apart.
const LAST_RUN_COLS = Object.keys(lastRunShape).join(", ");

// Maps a settled handle to its verdict. A provider refusal outranks
// every other signal — goose prints its usage-limit record and still
// exits 0, so the exit code alone would mislabel it "finished" (or
// "failed" and lose the reset time). An error without a refusal is a
// crash verdict; anything else settled by the book. A stop carrying a
// stopReason was the server's doing — the state stays "stopped" but the
// reason says why (#379).
const lastRunOutcomeFor = (handle: RunHandle): LastRunOutcome => ({
  state:
    handle.stopNotice !== undefined
      ? "stopped_early"
      : handle.status === "error"
        ? "failed"
        : handle.status === "stopped"
          ? "stopped"
          : "finished",
  // For "finished" neither field is set; the ?? order keeps a refusal's
  // notice (reset time included) ahead of any exit wording, and a
  // shutdown's reason behind both.
  reason: handle.stopNotice ?? handle.error ?? handle.stopReason,
});

const recordLastRun = (
  db: DatabaseSync,
  sessionId: string,
  outcome: LastRunOutcome,
): void => {
  db.prepare(
    `INSERT INTO last_run (${LAST_RUN_COLS}) VALUES (?, ?, ?, ?) ` +
      "ON CONFLICT(session_id) DO UPDATE SET " +
      "state = excluded.state, reason = excluded.reason, " +
      "ended_at = excluded.ended_at",
  ).run(
    sessionId,
    outcome.state,
    outcome.reason ?? null,
    new Date().toISOString(),
  );
};

const lastRunRowToRecord = (
  row: unknown,
): { sessionId: string; record: LastRunRecord } | undefined => {
  const parsed = LastRunRow(row);
  if (parsed instanceof type.errors) return undefined;
  const { session_id, state, reason, ended_at } = parsed;
  return {
    sessionId: session_id,
    record: {
      state,
      reason: reason ?? undefined,
      endedAt: ended_at,
    },
  };
};

const readLastRun = (
  db: DatabaseSync,
  sessionId: string,
): LastRunRecord | undefined => {
  try {
    const row = db
      .prepare(`SELECT ${LAST_RUN_COLS} FROM last_run WHERE session_id = ?`)
      .get(sessionId);
    return lastRunRowToRecord(row)?.record;
  } catch {
    return undefined;
  }
};

// Every verdict at once, indexed by session id — one query for a
// listing read instead of one per row. Malformed rows are skipped.
const readLastRuns = (db: DatabaseSync): Map<string, LastRunRecord> => {
  const out = new Map<string, LastRunRecord>();
  try {
    addVerdictRows(db, out);
  } catch {
    // A missing table (a pre-verdict database opened read-only) reads
    // as no verdicts at all.
  }
  return out;
};

const addVerdictRows = (
  db: DatabaseSync,
  out: Map<string, LastRunRecord>,
): void => {
  const rows = db.prepare(`SELECT ${LAST_RUN_COLS} FROM last_run`).all();
  for (const row of rows) {
    const entry = lastRunRowToRecord(row);
    if (entry !== undefined) out.set(entry.sessionId, entry.record);
  }
};

export type { LastRunOutcome, LastRunRecord };
export {
  clearStopNotice,
  LastRunState,
  lastRunOutcomeFor,
  openStopNoticesDb,
  readLastRun,
  readLastRuns,
  readStopNotice,
  recordLastRun,
  recordStopNotice,
  resolveStopNoticesDbPath,
};
