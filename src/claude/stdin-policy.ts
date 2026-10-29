import { type } from "arktype";
import { JsonObject, parseJson } from "../glv/parse.js";
import type { StdinClosePolicy } from "../glv/runner/types.js";
import { positiveEnvNumber, unrefTimer } from "../glv/util.js";

// When stdin is held open (stream-json input, ADR 0010), a headless
// claude session is live: pending background tasks survive the end of
// the turn that armed them, and their completion wakes the agent into
// a new turn — verified end to end against claude 2.1.289. The price
// is that the process no longer exits on its own at a turn boundary;
// it exits when stdin closes. This policy reads claude's own stream
// records and closes stdin once the run has nothing left to wait for:
// a turn has ended (the terminal `result` record) and the latest
// `background_tasks_changed` snapshot is empty. A run with a pending
// task holds: its completion is followed by a wake turn whose own
// result re-evaluates the rule, so a watcher that re-arms another
// watcher keeps the session alive turn after turn. Tasks that never
// complete (a dev server) park the run the way a Monitor task always
// has — the user stops it when they want it gone.

// How long a parked session may stay silent, after a turn ended with
// nothing pending, before stdin closes anyway. Pure defense: it bounds
// the park if a claude release ever completes (or kills) a task
// without waking the agent, instead of holding a runner slot forever.
// Generous by design — it must never fire between two records of one
// slow turn. GLV_CLAUDE_STDIN_IDLE_MS overrides it (the same
// test-facing pattern as GLV_STARTUP_TIMEOUT_MS).
const DEFAULT_IDLE_CLOSE_MS = 15_000;
const idleCloseMs = () =>
  positiveEnvNumber("GLV_CLAUDE_STDIN_IDLE_MS", DEFAULT_IDLE_CLOSE_MS);

// The terminal verdict of one turn. Every turn ends with exactly one —
// the initial prompt's, every wake turn's, and the error record a
// refusal produces — so it is the one reliable turn boundary.
const ResultRecord = type({ type: "'result'" });

// A full snapshot of the session's background tasks, emitted whenever
// the set changes. Snapshots (not deltas) make the pending count
// self-correcting — a missed record heals on the next one.
const TasksSnapshot = type({
  type: "'system'",
  subtype: "'background_tasks_changed'",
  tasks: type({ task_id: "string" }).array(),
});

// Marks the start of a turn — the first and every wake turn — so the
// idle defense never fires mid-turn.
const TurnStart = type({ type: "'system'", subtype: "'init'" });

// One stream line narrowed to the records the policy tracks, or
// undefined for everything else.
const trackedRecord = (
  line: string,
):
  | { kind: "result" }
  | { kind: "turn-start" }
  | { kind: "tasks"; pending: number }
  | undefined => {
  const parsed = parseJson(line, JsonObject);
  if (!parsed.ok) return undefined;
  const asResult = ResultRecord(parsed.data);
  if (!(asResult instanceof type.errors)) return { kind: "result" };
  const asTurnStart = TurnStart(parsed.data);
  if (!(asTurnStart instanceof type.errors)) return { kind: "turn-start" };
  const asTasks = TasksSnapshot(parsed.data);
  if (asTasks instanceof type.errors) return undefined;
  return { kind: "tasks", pending: asTasks.tasks.length };
};

// The stdin close policy for claude runs (see the top of this file).
const claudeStdinPolicy: StdinClosePolicy = (close) => {
  let pendingTasks = 0;
  let turnOpen = false;
  let sawResult = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdle = (): void => {
    if (idleTimer === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const closeNow = (): void => {
    clearIdle();
    close();
  };

  // Arms the idle defense: the turn is over, nothing is pending, and a
  // stream this quiet will not be woken again — closing stdin lets the
  // process exit instead of parking forever.
  const armIdle = (): void => {
    clearIdle();
    idleTimer = setTimeout(closeNow, idleCloseMs());
    unrefTimer(idleTimer);
  };

  const onTurnStart = (): void => {
    // A turn in flight owns the session; its result decides.
    turnOpen = true;
    clearIdle();
  };

  const onResult = (): void => {
    turnOpen = false;
    sawResult = true;
    // A finished run must not wait out the idle window.
    if (pendingTasks === 0) closeNow();
  };

  const onTasks = (pending: number): void => {
    pendingTasks = pending;
    // The pending set emptied while parked after a result: the wake
    // that usually follows gets its own result, and a stream that goes
    // quiet instead is a completion that will never wake anyone.
    if (!turnOpen && sawResult && pending === 0) armIdle();
  };

  return {
    onLine: (line: string): void => {
      const record = trackedRecord(line);
      if (record === undefined) return;
      if (record.kind === "result") onResult();
      else if (record.kind === "tasks") onTasks(record.pending);
      else onTurnStart();
    },
    stop: clearIdle,
  };
};

export { claudeStdinPolicy };
