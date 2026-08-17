import { randomUUID } from "node:crypto";
import type { SessionLauncher } from "../glv/launch.js";
import type { SessionStore } from "../glv/sessions.js";
import { enqueueNewSession, type Runner, stop } from "./runner/index.js";
import { findTranscript } from "./store/transcript.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// claude supports pre-assigning the session id (--session-id <uuid>), so glv
// generates the id itself and hands it to the run. The id is known before
// the process starts — there is no discovery poll and no chance of
// attributing an unrelated transcript (say, one started from a terminal in
// the same directory) to this run.
const makeClaudeLauncher = (
  root: string,
  sessions: SessionStore,
  runner: Runner,
  timeoutError: string,
): SessionLauncher => ({
  startNew: (workingDir, prompt) => {
    const sessionId = randomUUID();
    enqueueNewSession(runner, sessionId, prompt, workingDir);
    return sessionId;
  },
  // Confirms the agent actually created the pre-assigned session's data
  // within the timeout. Only this one specific id is checked, so a
  // misattribution is impossible by construction.
  awaitNew: async (handle, _workingDir, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (findTranscript(root, handle) !== undefined) return handle;
      await sleep(50);
    }
    return undefined;
  },
  establish: (handle, sessionId, _conflictError) => {
    const session = sessions.getSession(sessionId);
    if (session === undefined) {
      stop(runner, handle);
      return { ok: false, status: 502, error: timeoutError };
    }
    return { ok: true, sessionId, session };
  },
});

export { makeClaudeLauncher };
