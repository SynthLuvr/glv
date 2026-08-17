import type { DatabaseSync } from "node:sqlite";
import type { SessionLauncher } from "../glv/launch.js";
import {
  enqueueNewSession,
  generateTempKey,
  type Runner,
  rekey,
  stop,
} from "../glv/runner/index.js";
import { getSession, sessionIdsInDir } from "./db.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// goose picks the session id itself, so a new run starts under a temporary
// key and the real id is discovered by polling for a session row that did
// not exist before the run was enqueued. `known` must be captured before
// enqueueing; otherwise a fast run could write its session before the
// snapshot and hide it from the discovery poll.
const makeGooseLauncher = (
  db: DatabaseSync,
  runner: Runner,
  timeoutError: string,
): SessionLauncher => {
  const knownIds = new Map<string, Set<string>>();
  return {
    startNew: (workingDir, prompt) => {
      const tempKey = generateTempKey();
      knownIds.set(tempKey, new Set(sessionIdsInDir(db, workingDir)));
      enqueueNewSession(runner, tempKey, prompt, workingDir);
      return tempKey;
    },
    awaitNew: async (handle, workingDir, timeoutMs) => {
      const known = knownIds.get(handle) ?? new Set<string>();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = sessionIdsInDir(db, workingDir).find(
          (id) => !known.has(id),
        );
        if (found !== undefined) return found;
        await sleep(50);
      }
      knownIds.delete(handle);
      return undefined;
    },
    establish: (handle, sessionId, conflictError) => {
      knownIds.delete(handle);
      // Rekey the temp handle onto the real id; a collision means another
      // run raced us onto the same id, so stop rather than clobber.
      if (!rekey(runner, handle, sessionId)) {
        stop(runner, handle);
        return { ok: false, status: 409, error: conflictError };
      }
      const session = getSession(db, sessionId);
      if (session === undefined) {
        stop(runner, sessionId);
        return { ok: false, status: 502, error: timeoutError };
      }
      return { ok: true, sessionId, session };
    },
  };
};

export { makeGooseLauncher };
