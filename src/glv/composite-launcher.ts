import { namespacedId, splitNamespacedId } from "./agents.js";
import type { EstablishOutcome, SessionLauncher } from "./launch.js";
import type { ModelSelection } from "./models.js";
import { type Runner, stop } from "./runner/index.js";
import type { AgentInvocation } from "./runner/types.js";
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
  ) => string;
  /**
   * Resolve the run's real namespaced session id, or undefined when the
   * agent did not create one within the timeout.
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
  return {
    startNewFor: (agent, workingDir, prompt, model) => {
      const child = childOf(agent);
      if (child === undefined)
        throw new Error(`agent "${agent}" is not enabled`);
      return child.startNew(workingDir, prompt, model);
    },
    awaitNew: async (handle, workingDir, timeoutMs) => {
      const split = splitNamespacedId(handle);
      const child = split === undefined ? undefined : childOf(split.agent);
      if (child === undefined || split === undefined) return undefined;
      return child.awaitNew(handle, workingDir, timeoutMs);
    },
    establish: (handle, sessionId, conflictError) => {
      const split = splitNamespacedId(handle);
      const child = split === undefined ? undefined : childOf(split.agent);
      if (child === undefined || split === undefined)
        return {
          ok: false,
          status: 404,
          error: `agent "${split?.agent ?? handle}" is not enabled`,
        };
      return child.establish(handle, sessionId, conflictError);
    },
  };
};

// The single-agent identity: one launcher, one agent id. Ids and handles
// pass through untouched (they may be raw — the legacy per-flavor
// servers) or already namespaced (glv serving one agent).
const singleAgentDispatch = (
  launcher: SessionLauncher,
): AgentDispatchLauncher => ({
  startNewFor: (_agent, workingDir, prompt, model) =>
    launcher.startNew(workingDir, prompt, model),
  awaitNew: (handle, workingDir, timeoutMs) =>
    launcher.awaitNew(handle, workingDir, timeoutMs),
  establish: (handle, sessionId, conflictError) =>
    launcher.establish(handle, sessionId, conflictError),
});

// The argv-building view of an agent for a namespaced runner: registry
// keys carry the prefix, but the agent binary must receive native ids
// (claude's --session-id is a real transcript name), so the key is
// stripped before the flavor builds argv. The empty prefix is the
// identity — the legacy single-flavor servers pass raw keys throughout.
const prefixedInvocation = (
  invocation: AgentInvocation,
  prefix: string,
): AgentInvocation => {
  if (prefix === "") return invocation;
  const native = (key: string): string => key.slice(prefix.length + 1);
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

// Key translation for a child launcher: runner keys and every id that
// crosses the boundary are namespaced; the flavor's own store and binary
// see native ids. The empty prefix is the identity.
const launcherKeys = (prefix: string) => ({
  out: (nativeId: string): string =>
    prefix === "" ? nativeId : namespacedId(prefix, nativeId),
  native: (key: string): string =>
    prefix === "" ? key : key.slice(prefix.length + 1),
});

export type { AgentDispatchLauncher, CompositeLauncherEntry };
export {
  createCompositeLauncher,
  establishSession,
  launcherKeys,
  prefixedInvocation,
  singleAgentDispatch,
};
