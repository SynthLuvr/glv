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

// A run is finished — eligible for eviction once no stream is watching it.
const isTerminalStatus = (status: RunStatus): boolean =>
  status === "completed" || status === "stopped" || status === "error";

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

// Drop a finished handle from the registry and release everything it holds
// (captured output, callbacks, the process handle) so it can be garbage
// collected. The registry is the only long-lived reference on a server, so
// removing it is what bounds memory across an unbounded number of sessions.
const evictHandle = (runner: Runner, handle: InternalHandle): void => {
  if (handle.evictionTimer !== undefined) {
    clearTimeout(handle.evictionTimer);
    handle.evictionTimer = undefined;
  }
  // Only remove if this handle is still the one registered under its key — a
  // re-prompt may have replaced a finished handle with a fresh one, and the
  // old handle's lingering timer must not evict the new one.
  if (runner.registry.get(handle.sessionId) === handle)
    runner.registry.delete(handle.sessionId);
  handle.lines = [];
  handle.lineOffset = 0;
  handle.process = undefined;
  handle.onLine = undefined;
  handle.onStatus = undefined;
};

// Evict once a run is finished AND every live SSE stream has drained it.
const maybeEvict = (runner: Runner, handle: InternalHandle): void => {
  if (handle.streamCount > 0) return;
  if (!isTerminalStatus(handle.status)) return;
  evictHandle(runner, handle);
};

// Finished handles linger briefly so late reconnects and post-completion
// status reads still resolve; the timer is unreferenced so it never keeps a
// shutting-down server alive. retentionMs <= 0 evicts immediately.
const scheduleEviction = (runner: Runner, handle: InternalHandle): void => {
  if (handle.evictionTimer !== undefined) return;
  if (runner.config.retentionMs <= 0) {
    maybeEvict(runner, handle);
    return;
  }
  handle.evictionTimer = setTimeout(() => {
    handle.evictionTimer = undefined;
    maybeEvict(runner, handle);
  }, runner.config.retentionMs);
  handle.evictionTimer.unref();
};

// A live SSE stream attaches so a finished run isn't evicted mid-drain; the
// matching release re-checks eviction (deferring-to-detach for watched runs).
const registerStream = (runner: Runner, sessionId: string): void => {
  const handle = runner.registry.get(sessionId);
  if (handle !== undefined) handle.streamCount++;
};

const releaseStream = (runner: Runner, sessionId: string): void => {
  const handle = runner.registry.get(sessionId);
  if (handle === undefined) return;
  if (handle.streamCount > 0) handle.streamCount--;
  maybeEvict(runner, handle);
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
    lineOffset: 0,
    error: undefined,
    cancelled: false,
    process: undefined,
    streamCount: 0,
    evictionTimer: undefined,
    onLine: opts.onLine,
    onStatus: opts.onStatus,
  };
  runner.registry.set(key, handle);
  refreshQueuePositions(runner);

  void runner.queue.add(async () => {
    try {
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
    } finally {
      // The run has reached its terminal status; arrange for the handle (and
      // its captured output) to leave the registry once no stream needs it.
      scheduleEviction(runner, handle);
    }
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

const rekey = (runner: Runner, oldKey: string, newKey: string): boolean => {
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
    return true;
  }

  if (handle.status === "running" && handle.process !== undefined) {
    handle.status = "stopped";
    handle.pendingPrompts = [];
    handle.process.kill("SIGINT");
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
  registerStream,
  rekey,
  releaseStream,
  stop,
  stopAll,
};
