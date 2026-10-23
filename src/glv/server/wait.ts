import type { Runner } from "../runner/index.js";
import { getHandle } from "../runner/index.js";

// The long-poll behind GET /api/sessions/:id/wait (#341): one request
// parks while the session's run is queued or running and answers the
// moment it settles — the sequencing primitive an orchestration script
// (fix run → refactor run → merge) needs, in place of the poll loop it
// used to hold over the detail endpoint.

// The answers a wait can carry: settled (the run's terminal state, or
// "idle" when no run is registered at all — the same vocabulary the
// session rows speak) or still-active when the caller's deadline hit.
type WaitOutcome =
  | {
      readonly settled: true;
      readonly status: "completed" | "stopped" | "error" | "idle";
    }
  | { readonly settled: false; readonly status: "queued" | "running" };

// One registry read: a terminal handle settles the wait, no handle
// reads as idle, anything else keeps it parked. The verdict beside the
// status (the sidecar's last_run record) is read by the route at
// answer time, not here — the runner stays storage-free.
const waitSnapshot = (runner: Runner, sessionId: string): WaitOutcome => {
  const status = getHandle(runner, sessionId)?.status;
  if (status === "queued" || status === "running")
    return { settled: false, status };
  if (status !== undefined) return { settled: true, status };
  return { settled: true, status: "idle" };
};

// Tick rate of the wait loop. A tick is an in-memory map lookup, so a
// fast rate only buys answer latency; 100 ms resolves well inside any
// caller's own cadence, and orders below the ~30 s a settled run
// lingers in the registry, so a tick can never miss the terminal state
// it is waiting for.
const WAIT_POLL_MS = 100;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls the registry until the run settles, the deadline passes, or the
// caller's connection drops — whichever comes first. A still-active
// return means the deadline hit; a cancelled connection's snapshot is
// discarded by the route, which has nobody left to answer.
//
// A tick cannot race the run-settle bookkeeping: the runner flips a
// handle terminal and persists the sidecar verdict in one synchronous
// continuation (queue.ts fires notifyRunEnd — the observer that writes
// last_run — immediately after the status flips, with no await between,
// and a chained advance follows in the same turn), and microtasks drain
// before the next timer tick. By the time a tick observes a terminal
// status, the verdict the route reads beside it has already landed.
const waitForRunSettle = async (
  runner: Runner,
  sessionId: string,
  timeoutMs: number,
  isCancelled?: () => boolean,
): Promise<WaitOutcome> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = waitSnapshot(runner, sessionId);
    if (snapshot.settled) return snapshot;
    if (isCancelled?.() === true) return snapshot;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return snapshot;
    await sleep(Math.min(WAIT_POLL_MS, remaining));
  }
};

export type { WaitOutcome };
export { waitForRunSettle };
