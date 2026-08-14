import { randomUUID } from "node:crypto";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getSession, type SessionRow, type SessionStore } from "../db.js";
import type { RunHandle } from "../runner/index.js";
import { enqueueNewSession, isTerminalStatus, stop } from "../runner/index.js";
import { findTranscript } from "../store/transcript.js";
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

// claude supports pre-assigning the session id (--session-id <uuid>), so glv
// generates the id itself and hands it to the run. The id is known before
// the process starts — there is no discovery poll and no chance of
// attributing an unrelated transcript (say, one started from a terminal in
// the same directory) to this run.
const prepareNewSession = (
  ctx: ServerContext,
  workingDir: string,
  prompt: string,
): string => {
  const sessionId = randomUUID();
  enqueueNewSession(ctx.runner, sessionId, prompt, workingDir);
  return sessionId;
};

// Confirms claude actually created the pre-assigned session's transcript
// within the timeout. Only this one specific file is checked, so a
// misattribution is impossible by construction.
const waitForTranscript = async (
  store: SessionStore,
  sessionId: string,
  timeoutMs = 10000,
  intervalMs = 50,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findTranscript(store.root, sessionId) !== undefined) return true;
    await sleep(intervalMs);
  }
  return false;
};

type EstablishOutcome =
  | { ok: true; sessionId: string; session: SessionRow }
  | { ok: false; status: ContentfulStatusCode; error: string };

// Confirms the session's transcript is readable and returns it, stopping the
// run on failure. Safe inside an existing withCreateLock task — this never
// acquires the lock itself.
const establishSession = (
  ctx: ServerContext,
  sessionId: string,
): EstablishOutcome => {
  const session = getSession(ctx.store, sessionId);
  if (session === undefined) {
    stop(ctx.runner, sessionId);
    return { ok: false, status: 502, error: SESSION_TIMEOUT_ERROR };
  }
  return { ok: true, sessionId, session };
};

export type { EstablishOutcome };
export {
  activeRunPrompt,
  establishSession,
  prepareNewSession,
  waitForTranscript,
  withCreateLock,
};
