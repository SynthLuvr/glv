import { randomUUID } from "node:crypto";
import type { ModelSelection } from "../models.js";
import { createRingBuffer } from "./ring-buffer.js";
import { runProcess } from "./spawn.js";
import type {
  InternalHandle,
  Invocation,
  RunHandle,
  Runner,
  RunStatus,
} from "./types.js";

const failRun = (handle: InternalHandle, err: unknown): void => {
  if (handle.status === "stopped") return;
  handle.status = "error";
  handle.error = err instanceof Error ? err.message : String(err);
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
// glimpse the terminal status of the run that just finished.
const advanceChain = (
  runner: Runner,
  handle: InternalHandle,
): Invocation | undefined => {
  if (handle.status === "stopped") {
    handle.pendingPrompts = [];
    return undefined;
  }
  const next = handle.pendingPrompts.shift();
  if (next === undefined) return undefined;
  const nextPrompt = next.prompt;
  handle.startedPrompts.push(nextPrompt);
  handle.prompt = nextPrompt;
  handle.error = undefined;
  handle.status = "running";
  return {
    args: runner.config.agent.resume(handle.sessionId, nextPrompt),
    stdin: nextPrompt,
  };
};

const enqueueInvocation = (
  runner: Runner,
  key: string,
  invocation: Invocation,
  workingDir: string,
): RunHandle => {
  const existing = runner.registry.get(key);
  if (existing !== undefined && isActiveStatus(existing.status))
    throw new Error(`Session ${key} already has an active or queued run`);

  const handle: InternalHandle = {
    sessionId: key,
    prompt: invocation.stdin,
    pendingPrompts: [],
    startedPrompts: [],
    steerable: runner.config.agent.steer !== undefined,
    steeredCount: 0,
    turnsStarted: 0,
    stdinClosed: false,
    workingDir,
    status: "queued",
    queuePosition: undefined,
    output: createRingBuffer(runner.config.maxLines),
    error: undefined,
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
      refreshQueuePositions(runner);

      try {
        await runProcess(runner, handle, currentInvocation);
      } catch (err) {
        failRun(handle, err);
      }
      handle.process = undefined;

      currentInvocation = advanceChain(runner, handle);
    }
    scheduleEviction(runner, handle);
  });

  return handle;
};

// A brand-new run: the agent builder decides whether the handle key is
// forwarded to the binary (claude's --session-id) or discovered afterwards.
const enqueueNewSession = (
  runner: Runner,
  key: string,
  prompt: string,
  workingDir: string,
  model?: ModelSelection,
): RunHandle =>
  enqueueInvocation(
    runner,
    key,
    { args: runner.config.agent.newSession(prompt, key, model), stdin: prompt },
    workingDir,
  );

// A follow-up run on an existing session.
const enqueueRun = (
  runner: Runner,
  key: string,
  prompt: string,
  workingDir: string,
): RunHandle =>
  enqueueInvocation(
    runner,
    key,
    { args: runner.config.agent.resume(key, prompt), stdin: prompt },
    workingDir,
  );

const enqueueOrQueue = (
  runner: Runner,
  sessionId: string,
  prompt: string,
  workingDir: string,
): { handle: RunHandle; queued: boolean } => {
  const existing = runner.registry.get(sessionId);
  if (existing !== undefined && isActiveStatus(existing.status)) {
    existing.pendingPrompts.push({ prompt, mode: "queue" });
    return { handle: existing, queued: true };
  }
  return {
    handle: enqueueRun(runner, sessionId, prompt, workingDir),
    queued: false,
  };
};

// Steer-mode delivery: hand the prompt to the live agent process instead of
// waiting for the current run to finish. Falls back to the pending queue —
// never losing the prompt — whenever a live write is impossible:
// - the session is idle → a brand-new run (identical to enqueueOrQueue);
// - the run is still queued (no process yet) → steer-tagged pending,
//   written to stdin the moment the process spawns;
// - the process's stdin already closed after its final turn (the
//   missed-window race) → steer-tagged pending that advanceChain chains
//   via the familiar resume invocation;
// - the flavor cannot steer at all → plain queue-mode pending.
// A write that throws synchronously (the process died without closing its
// stdin) fails the run outright — the same surface as a process crash.
const steer = (
  runner: Runner,
  sessionId: string,
  prompt: string,
  workingDir: string,
): { handle: RunHandle; delivered: boolean } => {
  const spec = runner.config.agent.steer;
  const existing = runner.registry.get(sessionId);
  if (existing === undefined || !isActiveStatus(existing.status))
    return {
      handle: enqueueRun(runner, sessionId, prompt, workingDir),
      delivered: false,
    };
  if (
    spec !== undefined &&
    existing.steerable &&
    existing.status === "running" &&
    !existing.stdinClosed &&
    existing.process !== undefined
  ) {
    try {
      existing.process.write(spec.encode(prompt));
    } catch (err) {
      failRun(existing, err);
      return { handle: existing, delivered: false };
    }
    existing.startedPrompts.push(prompt);
    existing.steeredCount++;
    existing.turnsStarted++;
    return { handle: existing, delivered: true };
  }
  existing.pendingPrompts.push({
    prompt,
    mode: spec !== undefined && existing.steerable ? "steer" : "queue",
  });
  return { handle: existing, delivered: false };
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
  return true;
};

// Prefixed so it can never collide with a real agent session id.
const generateTempKey = (): string => `tmp_${randomUUID()}`;

const stop = (runner: Runner, sessionId: string): boolean => {
  const handle = runner.registry.get(sessionId);
  if (handle === undefined) return false;

  if (handle.status === "queued") {
    handle.cancelled = true;
    handle.status = "stopped";
    handle.pendingPrompts = [];
    handle.queuePosition = undefined;
    refreshQueuePositions(runner);
    scheduleEviction(runner, handle);
    return true;
  }

  if (handle.status === "running") {
    handle.status = "stopped";
    handle.pendingPrompts = [];
    // A running handle may briefly have no process (the spawn assignment
    // hasn't run yet); in that case defer the kill via cancelled.
    if (handle.process !== undefined) handle.process.kill("SIGINT");
    else handle.cancelled = true;
    return true;
  }

  return false;
};

// Reaps all live agent processes on server shutdown.
const stopAll = (runner: Runner): number => {
  let stopped = 0;
  for (const sessionId of runner.registry.keys())
    if (stop(runner, sessionId)) stopped++;
  return stopped;
};

export {
  clearPending,
  enqueueNewSession,
  enqueueOrQueue,
  enqueueRun,
  generateTempKey,
  rekey,
  steer,
  stop,
  stopAll,
};
