import { runProcess } from "./spawn.js";
import type {
  EnqueueOptions,
  GooseInvocation,
  InternalHandle,
  RunHandle,
  Runner,
  RunStatus,
} from "./types.js";
import { newSessionInvocation, resumeInvocation } from "./types.js";

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
    if (handle.queuePosition !== position) {
      handle.queuePosition = position;
      handle.onStatus?.(handle);
    }
    position++;
  }
};

const isActiveStatus = (status: RunStatus): boolean =>
  status === "queued" || status === "running";

// `unref` keeps a pending eviction timer from blocking process exit; guarded
// because the global setTimeout type may resolve to a number in DOM-libs.
const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  (timer as { unref?: () => void }).unref?.();
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
const advanceChain = (handle: InternalHandle): GooseInvocation | undefined => {
  if (handle.status === "stopped") {
    handle.pendingPrompts = [];
    return undefined;
  }
  const nextPrompt = handle.pendingPrompts.shift();
  if (nextPrompt === undefined) return undefined;
  handle.startedPrompts.push(nextPrompt);
  handle.prompt = nextPrompt;
  handle.error = undefined;
  handle.status = "running";
  return resumeInvocation(handle.sessionId, nextPrompt);
};

const enqueueInvocation = (
  runner: Runner,
  key: string,
  invocation: GooseInvocation,
  workingDir: string,
  opts: EnqueueOptions = {},
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
    status: "queued",
    queuePosition: undefined,
    lines: [],
    error: undefined,
    cancelled: false,
    process: undefined,
    onLine: opts.onLine,
    onStatus: opts.onStatus,
    droppedLines: 0,
    evictionTimer: undefined,
  };
  clearEviction(existing);
  runner.registry.set(key, handle);
  refreshQueuePositions(runner);

  void runner.queue.add(async () => {
    let currentInvocation: GooseInvocation | undefined = invocation;
    while (currentInvocation !== undefined) {
      if (handle.cancelled) return;
      handle.status = "running";
      handle.queuePosition = undefined;
      handle.onStatus?.(handle);
      refreshQueuePositions(runner);

      try {
        await runProcess(runner, handle, currentInvocation);
      } catch (err) {
        failRun(handle, err);
      }
      handle.process = undefined;

      currentInvocation = advanceChain(handle);
      if (currentInvocation !== undefined) handle.onStatus?.(handle);
    }
    handle.onStatus?.(handle);
    scheduleEviction(runner, handle);
  });

  return handle;
};

const enqueue = (
  runner: Runner,
  sessionId: string,
  prompt: string,
  workingDir: string,
  opts: EnqueueOptions = {},
): RunHandle =>
  enqueueInvocation(
    runner,
    sessionId,
    resumeInvocation(sessionId, prompt),
    workingDir,
    opts,
  );

const enqueueOrQueue = (
  runner: Runner,
  sessionId: string,
  prompt: string,
  workingDir: string,
  opts: EnqueueOptions = {},
): { handle: RunHandle; queued: boolean } => {
  const existing = runner.registry.get(sessionId);
  if (existing !== undefined && isActiveStatus(existing.status)) {
    existing.pendingPrompts.push(prompt);
    existing.onStatus?.(existing);
    return { handle: existing, queued: true };
  }
  return {
    handle: enqueue(runner, sessionId, prompt, workingDir, opts),
    queued: false,
  };
};

const clearPending = (runner: Runner, sessionId: string): number => {
  const handle = runner.registry.get(sessionId);
  if (handle === undefined) return 0;
  const count = handle.pendingPrompts.length;
  if (count === 0) return 0;
  handle.pendingPrompts = [];
  handle.onStatus?.(handle);
  return count;
};

const enqueueNew = (
  runner: Runner,
  tempKey: string,
  prompt: string,
  workingDir: string,
  opts: EnqueueOptions = {},
): RunHandle =>
  enqueueInvocation(
    runner,
    tempKey,
    newSessionInvocation(prompt),
    workingDir,
    opts,
  );

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

// Prefixed so it can never collide with a real goose session id.
const generateTempKey = (): string =>
  `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

const stop = (runner: Runner, sessionId: string): boolean => {
  const handle = runner.registry.get(sessionId);
  if (handle === undefined) return false;

  if (handle.status === "queued") {
    handle.cancelled = true;
    handle.status = "stopped";
    handle.pendingPrompts = [];
    handle.queuePosition = undefined;
    handle.onStatus?.(handle);
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

// Reaps all live goose processes on server shutdown.
const stopAll = (runner: Runner): number => {
  let stopped = 0;
  for (const sessionId of runner.registry.keys())
    if (stop(runner, sessionId)) stopped++;
  return stopped;
};

export {
  clearPending,
  enqueue,
  enqueueNew,
  enqueueOrQueue,
  generateTempKey,
  rekey,
  stop,
  stopAll,
};
