import { agentOfId, namespacedId } from "./agents.js";
import type { EstablishOutcome, SessionLauncher } from "./launch.js";
import type { ModelSelection } from "./models.js";
import { type Runner, stop } from "./runner/index.js";
import type { AgentInvocation, MemoryCeiling } from "./runner/types.js";
import type { SessionRow } from "./sessions.js";

// The launcher routes consume: like SessionLauncher, but a new run names
// its agent (the New Session form and each cron row carry the choice);
// awaitNew/establish dispatch on the handle's own prefix.
type AgentDispatchLauncher = {
  /** Enqueue a run for `agent` and return an opaque namespaced handle. */
  readonly startNewFor: (
    agent: string,
    workingDir: string,
    prompt: string,
    model?: ModelSelection,
    memoryMax?: MemoryCeiling,
  ) => string;
  /**
   * Resolve the run's real namespaced session id, or undefined when the
   * agent did not create one within the timeout. The timeout bounds only
   * the agent's own startup + session creation; a run queued behind the
   * concurrency limit waits out the queue first, without spending the
   * timeout.
   */
  readonly awaitNew: (
    handle: string,
    workingDir: string,
    timeoutMs: number,
  ) => Promise<string | undefined>;
  /**
   * Bind the handle to the real (namespaced) session id and confirm the
   * session is readable, stopping the run on failure. `conflictError`
   * localises the 409 copy; strategies that cannot conflict ignore it.
   */
  readonly establish: (
    handle: string,
    sessionId: string,
    conflictError: string,
  ) => EstablishOutcome;
};

// One agent's launcher under the composite.
type CompositeLauncherEntry = {
  readonly agent: string;
  readonly launcher: SessionLauncher;
};

// Dispatches to the child launcher the prefix names. Handles and session
// ids arrive and leave namespaced; each child launcher is constructed
// with its own prefix so the ids it returns outward already carry it.
const createCompositeLauncher = (
  entries: readonly CompositeLauncherEntry[],
): AgentDispatchLauncher => {
  const childOf = (agent: string): SessionLauncher | undefined =>
    entries.find((entry) => entry.agent === agent)?.launcher;
  const childForHandle = (handle: string): SessionLauncher | undefined => {
    const agent = agentOfId(handle);
    return agent === undefined ? undefined : childOf(agent);
  };
  return {
    startNewFor: (agent, workingDir, prompt, model, memoryMax) => {
      const child = childOf(agent);
      if (child === undefined)
        throw new Error(`agent "${agent}" is not enabled`);
      return child.startNew(workingDir, prompt, model, memoryMax);
    },
    awaitNew: async (handle, workingDir, timeoutMs) => {
      const child = childForHandle(handle);
      return child === undefined
        ? undefined
        : child.awaitNew(handle, workingDir, timeoutMs);
    },
    establish: (handle, sessionId, conflictError) => {
      const child = childForHandle(handle);
      if (child !== undefined)
        return child.establish(handle, sessionId, conflictError);
      return {
        ok: false,
        status: 404,
        error: `agent "${agentOfId(handle) ?? handle}" is not enabled`,
      };
    },
  };
};

// Key translation for a child launcher: runner keys and every id that
// crosses the boundary are namespaced; the flavor's own store and binary
// see native ids.
const launcherKeys = (prefix: string) => ({
  out: (nativeId: string): string => namespacedId(prefix, nativeId),
  native: (key: string): string => key.slice(prefix.length + 1),
});

// The argv-building view of an agent for a namespaced runner: registry
// keys carry the prefix, but the agent binary must receive native ids
// (claude's --session-id is a real transcript name), so the key is
// stripped before the flavor builds argv.
const prefixedInvocation = (
  invocation: AgentInvocation,
  prefix: string,
): AgentInvocation => {
  const native = launcherKeys(prefix).native;
  return {
    ...invocation,
    newSession: (prompt, key, model) =>
      invocation.newSession(prompt, native(key), model),
    resume: (key, prompt) => invocation.resume(native(key), prompt),
  };
};

// The establish tail both flavors share: confirm the native session is
// readable (stopping the run when it is not) and hand back the row with
// its boundary spelling of the id.
const establishSession = (
  lookup: () => SessionRow | undefined,
  runner: Runner,
  handle: string,
  sessionId: string,
  timeoutError: string,
): EstablishOutcome => {
  const session = lookup();
  if (session === undefined) {
    stop(runner, handle);
    return { ok: false, status: 502, error: timeoutError };
  }
  return { ok: true, sessionId, session: { ...session, id: sessionId } };
};

export type { AgentDispatchLauncher, CompositeLauncherEntry };
export {
  createCompositeLauncher,
  establishSession,
  launcherKeys,
  prefixedInvocation,
};
