import type { DatabaseSync } from "node:sqlite";
import {
  establishSession,
  launcherKeys,
  prefixedInvocation,
} from "../glv/composite-launcher.js";
import type { SessionLauncher } from "../glv/launch.js";
import {
  awaitRunStart,
  enqueueNewSession,
  generateTempKey,
  type Runner,
  rekey,
  stop,
} from "../glv/runner/index.js";
import type { AgentInvocation } from "../glv/runner/types.js";
import { getSession, sessionIdsInDir } from "./db.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// goose picks the session id itself, so a new run starts under a temporary
// key and the real id is discovered by polling for a session row that did
// not exist before the run was enqueued. `known` must be captured before
// enqueueing; otherwise a fast run could write its session before the
// snapshot and hide it from the discovery poll.
//
// Under the merged product every id that crosses the launcher boundary is
// namespaced ("goose:<id>"); `prefix` ("goose") decides. Runner registry
// keys are namespaced too; the argv builder receives native ids through
// the prefixed invocation view.
const makeGooseLauncher = (
  db: DatabaseSync,
  runner: Runner,
  invocation: AgentInvocation,
  timeoutError: string,
  prefix: string,
): SessionLauncher => {
  const keys = launcherKeys(prefix);
  const agent = prefixedInvocation(invocation, prefix);
  const knownIds = new Map<string, Set<string>>();
  return {
    startNew: (workingDir, prompt, model, memoryMax) => {
      const tempKey = generateTempKey();
      knownIds.set(keys.out(tempKey), new Set(sessionIdsInDir(db, workingDir)));
      enqueueNewSession(
        runner,
        agent,
        keys.out(tempKey),
        prompt,
        workingDir,
        model,
        memoryMax,
      );
      return keys.out(tempKey);
    },
    awaitNew: async (handle, workingDir, timeoutMs) => {
      // A run parked in the concurrency queue has not spawned yet, so no
      // session can appear — waiting out the queue must not eat into the
      // discovery deadline, or a queued new session would always time out
      // (reported as "did not create a session in time"). Wait for the run
      // to start first; the deadline below then bounds only the agent's
      // own startup + session creation.
      if (!(await awaitRunStart(runner, handle))) return undefined;
      const known = knownIds.get(handle) ?? new Set<string>();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = sessionIdsInDir(db, workingDir).find(
          (id) => !known.has(id),
        );
        if (found !== undefined) return keys.out(found);
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
      return establishSession(
        () => getSession(db, keys.native(sessionId)),
        runner,
        handle,
        sessionId,
        timeoutError,
      );
    },
  };
};

export { makeGooseLauncher };
