import { randomUUID } from "node:crypto";
import {
  establishSession,
  launcherKeys,
  prefixedInvocation,
} from "../glv/composite-launcher.js";
import type { SessionLauncher } from "../glv/launch.js";
import { enqueueNewSession, type Runner } from "../glv/runner/index.js";
import type { AgentInvocation } from "../glv/runner/types.js";
import type { SessionStore } from "../glv/sessions.js";
import { findTranscript } from "./store/transcript.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// claude supports pre-assigning the session id (--session-id <uuid>), so glv
// generates the id itself and hands it to the run. The id is known before
// the process starts — there is no discovery poll and no chance of
// attributing an unrelated transcript (say, one started from a terminal in
// the same directory) to this run.
//
// Under the merged product every id that crosses the launcher boundary is
// namespaced ("claude:<id>"); `prefix` ("claude") decides. The binary
// still receives the native uuid through the prefixed invocation view.
const makeClaudeLauncher = (
  root: string,
  sessions: SessionStore,
  runner: Runner,
  invocation: AgentInvocation,
  timeoutError: string,
  prefix: string,
): SessionLauncher => {
  const keys = launcherKeys(prefix);
  const agent = prefixedInvocation(invocation, prefix);
  return {
    startNew: (workingDir, prompt) => {
      const sessionId = randomUUID();
      enqueueNewSession(runner, agent, keys.out(sessionId), prompt, workingDir);
      return keys.out(sessionId);
    },
    // Confirms the agent actually created the pre-assigned session's data
    // within the timeout. Only this one specific id is checked, so a
    // misattribution is impossible by construction.
    awaitNew: async (handle, _workingDir, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (findTranscript(root, keys.native(handle)) !== undefined)
          return handle;
        await sleep(50);
      }
      return undefined;
    },
    establish: (handle, sessionId, _conflictError) =>
      establishSession(
        () => sessions.getSession(keys.native(sessionId)),
        runner,
        handle,
        sessionId,
        timeoutError,
      ),
  };
};

export { makeClaudeLauncher };
