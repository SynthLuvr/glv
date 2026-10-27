import { randomUUID } from "node:crypto";
import type { ModelSelection } from "../models.js";
import { createRingBuffer } from "./ring-buffer.js";
import { isTerminalStatus } from "./runner.js";
import { runProcess } from "./spawn.js";
import type {
  AgentInvocation,
  InternalHandle,
  Invocation,
  RunHandle,
  Runner,
  RunStatus,
} from "./types.js";

// One invocation begins: it gets the identity the run-history recorder
// needs — a fresh runId (the settle notification(s) of this invocation
// share it, so a stop-request notify and the exit notify fold into one
// history row #384) and its start instant.
const beginInvocation = (handle: InternalHandle): void => {
  handle.runId = randomUUID();
  handle.startedAt = Date.now();
};

const failRun = (handle: InternalHandle, err: unknown): void => {
  if (handle.status === "stopped") return;
  handle.status = "error";
  handle.error = err instanceof Error ? err.message : String(err);
};

// Temp keys (pre-establishment handles) never name a viewable session;
// the launcher's rekey re-fires the observer under the real id once the
// session exists.
const isTempSessionKey = (sessionId: string): boolean =>
  /^([a-z]+:)?tmp_/.test(sessionId);

// Fires after every process exit (before advanceChain can flip the
// status for the next chained prompt) and again on rekey, so the
// observer always sees a settled run under the id the routes read.
const notifyRunEnd = (runner: Runner, handle: InternalHandle): void => {
  if (runner.onRunEnd === undefined) return;
  if (!isTerminalStatus(handle.status)) return;
  if (isTempSessionKey(handle.sessionId)) return;
  runner.onRunEnd(handle);
};

// Map preserves insertion order, so registry order mirrors queue order.
const refreshQueuePositions = (runner: Runner): void => {
  let position = 0;
  for (const handle of runner.registry.values()) {
    if (handle.status !== "queued") continue;
    if (handle.queuePosition !== position) handle.queuePosition = position;
    position++;
  }
};

const isActiveStatus = (status: RunStatus): boolean =>
  status === "queued" || status === "running";

// `unref` keeps a pending eviction timer from blocking process exit; guarded
// because the global setTimeout type may resolve to a number in DOM-libs.
const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  )
    timer.unref();
};

// Schedules a terminal handle for eviction from the registry after a short
// retention window. Identity-guarded: if the slot has since been re-enqueued
// or rekeyed, the timer leaves the new handle untouched.
const scheduleEviction = (runner: Runner, handle: InternalHandle): void => {
  if (handle.evictionTimer !== undefined) return;
  if (isActiveStatus(handle.status)) return;
  const timer = setTimeout(() => {
    handle.evictionTimer = undefined;
    if (runner.registry.get(handle.sessionId) === handle)
      runner.registry.delete(handle.sessionId);
  }, runner.config.terminalRetentionMs);
  unrefTimer(timer);
  handle.evictionTimer = timer;
};

// Cancels a pending eviction so a replaced handle's stale timer releases its
// reference and can't fire against the new handle (the identity guard would
// stop it anyway, but this also lets the old handle be GC'd promptly).
const clearEviction = (handle: InternalHandle | undefined): void => {
  if (handle === undefined || handle.evictionTimer === undefined) return;
  clearTimeout(handle.evictionTimer);
  handle.evictionTimer = undefined;
};

// Advance to the next queued prompt after a run finishes, or end the chain.
// A run that errored still chains onward; only "stopped" or an empty pending
// queue ends it. Every state change here is synchronous, so observers never
// glimpse the terminal status of the run that just finished. The handle's
// own agent builds the resume argv — one pool serves several.
const advanceChain = (handle: InternalHandle): Invocation | undefined => {
  if (handle.status === "stopped") {
    handle.pendingPrompts = [];
    return undefined;
  }
  const nextPrompt = handle.pendingPrompts.shift();
  if (nextPrompt === undefined) return undefined;
  handle.startedPrompts.push(nextPrompt);
  handle.prompt = nextPrompt;
  handle.error = undefined;
  handle.stopNotice = undefined;
  handle.stopReason = undefined;
  handle.status = "running";
  beginInvocation(handle);
  return {
    args: handle.agent.resume(handle.sessionId, nextPrompt),
    stdin: nextPrompt,
  };
};

const enqueueInvocation = (
  runner: Runner,
  key: string,
  invocation: Invocation,
  workingDir: string,
  agent: AgentInvocation,
): RunHandle => {
  const existing = runner.registry.get(key);
  if (existing !== undefined && isActiveStatus(existing.status))
    throw new Error(`Session ${key} already has an active or queued run`);

  const handle: InternalHandle = {
    sessionId: key,
    prompt: invocation.stdin,
    pendingPrompts: [],
    startedPrompts: [],
    workingDir,
    agent,
    status: "queued",
    queuePosition: undefined,
    output: createRingBuffer(runner.config.maxLines),
    error: undefined,
    stopNotice: undefined,
    stopReason: undefined,
    runId: undefined,
    startedAt: undefined,
    cancelled: false,
    process: undefined,
    evictionTimer: undefined,
  };
  clearEviction(existing);
  runner.registry.set(key, handle);
  refreshQueuePositions(runner);

  void runner.queue.add(async () => {
    let currentInvocation: Invocation | undefined = invocation;
    while (currentInvocation !== undefined) {
      if (handle.cancelled) return;
      handle.status = "running";
      handle.queuePosition = undefined;
      beginInvocation(handle);
      refreshQueuePositions(runner);

      try {
        await runProcess(runner, handle, currentInvocation);
      } catch (err) {
        failRun(handle, err);
      }
      handle.process = undefined;
      notifyRunEnd(runner, handle);

      currentInvocation = advanceChain(handle);
    }
    scheduleEviction(runner, handle);
  });

  return handle;
};

// A brand-new run: the agent builder decides whether the handle key is
// forwarded to the binary (claude's --session-id) or discovered afterwards.
const enqueueNewSession = (
  runner: Runner,
  agent: AgentInvocation,
  key: string,
  prompt: string,
  workingDir: string,
  model?: ModelSelection,
): RunHandle =>
  enqueueInvocation(
    runner,
    key,
    { args: agent.newSession(prompt, key, model), stdin: prompt },
    workingDir,
    agent,
  );

// A follow-up run on an existing session.
const enqueueRun = (
  runner: Runner,
  agent: AgentInvocation,
  key: string,
  prompt: string,
  workingDir: string,
): RunHandle =>
  enqueueInvocation(
    runner,
    key,
    { args: agent.resume(key, prompt), stdin: prompt },
    workingDir,
    agent,
  );

const enqueueOrQueue = (
  runner: Runner,
  agent: AgentInvocation,
  sessionId: string,
  prompt: string,
  workingDir: string,
): { handle: RunHandle; queued: boolean } => {
  const existing = runner.registry.get(sessionId);
  if (existing !== undefined && isActiveStatus(existing.status)) {
    existing.pendingPrompts.push(prompt);
    return { handle: existing, queued: true };
  }
  return {
    handle: enqueueRun(runner, agent, sessionId, prompt, workingDir),
    queued: false,
  };
};

const clearPending = (runner: Runner, sessionId: string): number => {
  const handle = runner.registry.get(sessionId);
  if (handle === undefined) return 0;
  const count = handle.pendingPrompts.length;
  if (count === 0) return 0;
  handle.pendingPrompts = [];
  return count;
};

// Returns false rather than clobbering so callers can stop the orphaned run.
const rekey = (runner: Runner, oldKey: string, newKey: string): boolean => {
  if (runner.registry.has(newKey)) return false;
  const handle = runner.registry.get(oldKey);
  if (handle === undefined) return false;
  runner.registry.delete(oldKey);
  handle.sessionId = newKey;
  runner.registry.set(newKey, handle);
  // A run that already settled under its temp key re-notifies under the
  // real id.
  notifyRunEnd(runner, handle);
  return true;
};

// Prefixed so it can never collide with a real agent session id.
const generateTempKey = (): string => `tmp_${randomUUID()}`;

// Stops one session's live or queued run. `reason` is set only when the
// stop did not come from the user (today, the server's shutdown
// teardown), so the persisted verdict can say so (#379).
const stop = (runner: Runner, sessionId: string, reason?: string): boolean => {
  const handle = runner.registry.get(sessionId);
  if (handle === undefined) return false;

  // A queued handle is stopped in place: nothing has spawned yet.
  if (handle.status === "queued") {
    handle.cancelled = true;
    handle.status = "stopped";
    handle.stopReason = reason;
    handle.pendingPrompts = [];
    handle.queuePosition = undefined;
    refreshQueuePositions(runner);
    scheduleEviction(runner, handle);
    notifyRunEnd(runner, handle);
    return true;
  }

  if (handle.status === "running") {
    handle.status = "stopped";
    handle.stopReason = reason;
    handle.pendingPrompts = [];
    // A running handle may briefly have no process (the spawn assignment
    // hasn't run yet); in that case defer the kill via cancelled.
    if (handle.process !== undefined) handle.process.kill("SIGINT");
    else handle.cancelled = true;
    // Notified here as well as at the exit below so a terminal status in
    // the registry never outruns its sidecar verdict: a read that lands
    // between the stop request and the process death (the wait
    // endpoint's poll, a detail read) still sees the verdict. The exit
    // re-notifies with the same verdict and the true settle instant.
    notifyRunEnd(runner, handle);
    return true;
  }

  return false;
};

// Reaps all live agent processes on server shutdown, recording why in
// each stopped run's last_run verdict (#379).
const stopAll = (runner: Runner, reason: string): number => {
  let stopped = 0;
  for (const sessionId of runner.registry.keys())
    if (stop(runner, sessionId, reason)) stopped++;
  if (stopped > 0)
    console.warn(`run: stopped ${stopped} live run(s): ${reason}`);
  return stopped;
};

export {
  clearPending,
  enqueueNewSession,
  enqueueOrQueue,
  enqueueRun,
  generateTempKey,
  rekey,
  stop,
  stopAll,
};
