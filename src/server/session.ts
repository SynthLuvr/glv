import type { DatabaseSync } from "node:sqlite";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getSession, type SessionRow, sessionIdsInDir } from "../db.js";
import type { RunHandle } from "../runner/index.js";
import {
  enqueueRun,
  generateTempKey,
  isTerminalStatus,
  rekey,
  stop,
} from "../runner/index.js";
import { SESSION_TIMEOUT_ERROR, type ServerContext } from "./context.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const activeRunPrompt = (run: RunHandle | undefined): string | undefined =>
  run !== undefined && !isTerminalStatus(run.status) ? run.prompt : undefined;

// Serializes async tasks per key. The stored tail swallows rejections so one
// failure can't poison the chain.
const withCreateLock = <T>(
  locks: Map<string, Promise<void>>,
  key: string,
  task: () => T | Promise<T>,
): Promise<T> => {
  const tail = locks.get(key) ?? Promise.resolve();
  const run = tail.then(task, task);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
};

// The single-query new-id primitive shared by both session-creation flows.
// The working-dir flow calls it in a blocking loop (pollForSessionId); the
// GitHub flow calls it once per client poll request.
const findNewSessionId = (
  db: DatabaseSync,
  workingDir: string,
  known: Set<string>,
): string | undefined =>
  sessionIdsInDir(db, workingDir).find((id) => !known.has(id));

const pollForSessionId = async (
  db: DatabaseSync,
  workingDir: string,
  known: Set<string>,
  timeoutMs = 10000,
  intervalMs = 50,
): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = findNewSessionId(db, workingDir, known);
    if (found !== undefined) return found;
    await sleep(intervalMs);
  }
  return undefined;
};

type PreparedSession = {
  tempKey: string;
  known: Set<string>;
};

// Snapshot-before-enqueue preamble shared by both flows. Generates a temp key,
// captures the known session ids in `workingDir`, then enqueues a new-session
// run. `known` is computed *before* enqueueing so the diff in
// findNewSessionId isolates exactly this run's new session.
const prepareNewSession = (
  ctx: ServerContext,
  workingDir: string,
  prompt: string,
): PreparedSession => {
  const tempKey = generateTempKey();
  const known = new Set(sessionIdsInDir(ctx.db, workingDir));
  enqueueRun(ctx.runner, tempKey, prompt, workingDir, {
    isNewSession: true,
  });
  return { tempKey, known };
};

type EstablishOutcome =
  | { ok: true; realId: string; session: SessionRow }
  | { ok: false; status: ContentfulStatusCode; error: string };

// Rekeys the temp run handle onto the real id and confirms the session row
// exists, stopping the run on either failure. `conflictError` localises the
// 409 copy ("directory" vs "repository"). Safe inside an existing
// withCreateLock task — this never acquires the lock itself.
const establishSession = (
  ctx: ServerContext,
  tempKey: string,
  realId: string,
  conflictError: string,
): EstablishOutcome => {
  if (!rekey(ctx.runner, tempKey, realId)) {
    stop(ctx.runner, tempKey);
    return { ok: false, status: 409, error: conflictError };
  }
  const session = getSession(ctx.db, realId);
  if (session === undefined) {
    stop(ctx.runner, realId);
    return { ok: false, status: 502, error: SESSION_TIMEOUT_ERROR };
  }
  return { ok: true, realId, session };
};

export type { EstablishOutcome, PreparedSession };
export {
  activeRunPrompt,
  establishSession,
  findNewSessionId,
  pollForSessionId,
  prepareNewSession,
  withCreateLock,
};
