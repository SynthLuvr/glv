import { type } from "arktype";
import { JsonObject, parseJson } from "../glv/parse.js";
import type { StdinClosePolicy } from "../glv/runner/types.js";
import { positiveEnvNumber, unrefTimer } from "../glv/util.js";

// When claude's stdin is held open (stream-json input, ADR 0010), the
// process treats the headless session as live: pending background
// tasks survive the end of a turn, and their completion wakes the
// agent into a new turn — verified end to end against claude 2.1.289.
// The price of a live session is that the process no longer exits on
// its own at a turn boundary; it exits when stdin closes. This policy
// reads claude's own stream records and closes stdin exactly when the
// run has nothing left to wait for:
//
// - a turn has ended (the terminal `result` record), and
// - no background task is pending (the latest
//   `background_tasks_changed` snapshot is empty).
//
// A run with nothing pending closes at its result — the settle timing
// of the old text-stdin model. A run with a pending task holds: the
// task's completion record is followed by a wake turn whose own result
// re-evaluates the rule, so a watcher that re-arms another watcher
// keeps the session alive turn after turn. Tasks that never complete
// (a dev server) park the run the way a Monitor task always has — the
// user stops it when they want it gone.

// How long a parked session may stay silent, after a turn ended with
// nothing pending, before stdin closes anyway. Every observed
// completion dispatches its wake within milliseconds, so this is pure
// defense: it bounds the park if a claude release ever completes (or
// kills) a task without waking the agent, instead of holding a runner
// slot forever. Generous by design — it must never fire between two
// records of one slow turn. GLV_CLAUDE_STDIN_IDLE_MS overrides it (the
// same test-facing pattern as GLV_STARTUP_TIMEOUT_MS).
const DEFAULT_IDLE_CLOSE_MS = 15_000;
const idleCloseMs = () =>
  positiveEnvNumber("GLV_CLAUDE_STDIN_IDLE_MS", DEFAULT_IDLE_CLOSE_MS);

// The terminal verdict of one turn. Every turn ends with exactly one —
// the initial prompt's, every wake turn's, and the error record a
// refusal produces — so it is the one reliable turn boundary.
const ResultRecord = type({ type: "'result'" });

// A full snapshot of the session's background tasks, emitted whenever
// the set changes: tasks are added on arm and dropped on completion,
// kill, or an explicit TaskStop. Snapshots (not deltas) make the
// pending set self-correcting — a missed record heals on the next one.
const TasksSnapshot = type({
  type: "'system'",
  subtype: "'background_tasks_changed'",
  tasks: type({ task_id: "string" }).array(),
});

// Marks the start of a turn (the first and every wake turn), so the
// idle defense never fires mid-turn.
const TurnStart = type({ type: "'system'", subtype: "'init'" });

// One stream line narrowed to the records the policy tracks, or
// undefined for everything else.
const trackedRecord = (
  line: string,
):
  | { kind: "result" }
  | { kind: "tasks"; taskIds: ReadonlySet<string> }
  | { kind: "turn-start" }
  | undefined => {
  const parsed = parseJson(line, JsonObject);
  if (!parsed.ok) return undefined;
  const asResult = ResultRecord(parsed.data);
  if (!(asResult instanceof type.errors)) return { kind: "result" };
  const asTurnStart = TurnStart(parsed.data);
  if (!(asTurnStart instanceof type.errors)) return { kind: "turn-start" };
  const asTasks = TasksSnapshot(parsed.data);
  if (asTasks instanceof type.errors) return undefined;
  return {
    kind: "tasks",
    taskIds: new Set(asTasks.tasks.map((t) => t.task_id)),
  };
};

// The stdin close policy for claude runs (see the top of this file).
const claudeStdinPolicy: StdinClosePolicy = (close) => {
  let pendingTaskIds: ReadonlySet<string> = new Set();
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

  return {
    onLine: (line: string): void => {
      const record = trackedRecord(line);
      if (record === undefined) return;
      if (record.kind === "turn-start") {
        turnOpen = true;
        // A turn in flight owns the session; its result decides.
        clearIdle();
        return;
      }
      if (record.kind === "tasks") pendingTaskIds = record.taskIds;

      if (record.kind === "result") {
        turnOpen = false;
        sawResult = true;
      }
      // Only end-of-turn states may close: a result record, or any
      // record while parked after one. The close itself is immediate
      // when nothing is pending (a finished run must not wait out the
      // idle window); the window only guards a park whose pending set
      // emptied after the result — the wake that usually follows gets
      // its own result, and a stream that goes quiet instead is a
      // completion that will never wake anyone.
      if (!turnOpen && sawResult && pendingTaskIds.size === 0)
        if (record.kind === "result") closeNow();
        else armIdle();
    },
    stop: clearIdle,
  };
};

export { claudeStdinPolicy };
