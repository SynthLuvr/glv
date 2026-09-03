import { type } from "arktype";
import { execa } from "execa";
import type {
  InternalHandle,
  Invocation,
  ProcessResult,
  Runner,
  SpawnedProcess,
  SpawnFn,
  SteerSpec,
} from "./types.js";

const describeFailure = (result: ProcessResult, name: string): string => {
  if (result.signal !== undefined)
    return `${name} killed by signal ${result.signal}`;
  if (result.exitCode === null) return `${name} process exited unexpectedly`;
  return `${name} exited with code ${result.exitCode}`;
};

const ExecaError = type({
  "exitCode?": "number | undefined",
  "signal?": "string | undefined",
});

const defaultSpawn: SpawnFn = (binary, args, opts) => {
  const proc = execa(binary, args, {
    // Steering runs keep stdin open (runProcess writes the initial message
    // itself); everything else writes-and-closes exactly as before.
    ...(opts.keepStdinOpen === true ? {} : { input: opts.stdin }),
    cwd: opts.cwd,
    // execa extends process.env with this, so the rest of the environment
    // is still inherited.
    env: opts.env,
    // killDescendants makes execa reap the whole process tree on kill —
    // process.kill(-pid) on Unix, taskkill /T /F on Windows — so the agent's
    // grandchildren (tool shells, sub-processes) are torn down too.
    killDescendants: true,
  });
  const pid = proc.pid ?? -1;

  const exit = proc.then(
    (r) => ({ exitCode: r.exitCode ?? 0 }),
    (e: unknown) => {
      if (!ExecaError.allows(e)) return { exitCode: null };
      return { exitCode: e.exitCode ?? null, signal: e.signal };
    },
  );

  // execa exposes no synchronous exit state, and its Windows tree-kill
  // (taskkill /PID <pid> /T /F) never verifies the pid still belongs to us
  // — dangerous where pids recycle quickly. Track liveness off the settled
  // promise so a retired pid is never signalled again.
  let exited = false;
  const markExited = (): void => {
    exited = true;
  };
  void proc.then(markExited, markExited);

  const kill = (signal: NodeJS.Signals = "SIGINT"): void => {
    if (!exited) proc.kill(signal);
  };

  // Mid-run steering channel. A synchronous throw (write-after-end) lets
  // the caller fail the run deterministically; an EPIPE surfaces
  // asynchronously through execa's rejection, which maps to the same
  // "process exited unexpectedly" error as any abnormal exit.
  const write = (line: string): void => {
    if (!proc.stdin.writable)
      throw new Error("agent stdin is no longer writable");
    proc.stdin.write(line.endsWith("\n") ? line : line + "\n");
  };

  const closeStdin = (): void => {
    if (proc.stdin.writable) proc.stdin.end();
  };

  // execa v9+ async iteration already yields one newline-stripped line
  // per iteration, so stdout needs no raw-chunk buffering/splitting here.
  return { pid, kill, stdout: proc, exit, write, closeStdin };
};

// A self-rearming interval polls handle.status in grace-sized windows so a
// stop() issued mid-run is noticed within one window; once stopped, each
// elapsed window escalates the kill signal — SIGTERM, then uncatchable
// SIGKILL — so a process that traps SIGINT can't park runProcess here
// forever, holding a runner slot and leaking its detached process group.
//
// Armed before the stdout drain below: the drain only evaluates its stop
// check when a new line arrives, so a stopped-but-silent process would
// park it forever and a ladder started after the drain would never fire.
//
// Windows has no POSIX signals: per Node's docs, kill() with SIGINT,
// SIGTERM, or SIGKILL unconditionally terminates the target at once, so
// the ladder collapses into a single hard kill — the agent gets no chance
// to flush state. execa routes each kill() to the right mechanism per
// platform, so no change is needed here.
const startStopEscalation = (
  proc: SpawnedProcess,
  handle: InternalHandle,
  graceMs: number,
): (() => void) => {
  let escalated = false;
  const poll = setInterval(() => {
    if (handle.status !== "stopped") return;
    if (escalated) {
      proc.kill("SIGKILL");
      return;
    }
    escalated = true;
    proc.kill("SIGTERM");
  }, graceMs);
  return () => clearInterval(poll);
};

// Delivers the initial prompt of a steerable run plus any steer-mode
// prompts queued while the run waited for a concurrency slot: all go to
// the fresh process's stdin, in order, before the stdout drain starts
// (each written message is one turn, answered by one turn-end record).
// Queue-mode pendings stay queued — they chain via advanceChain once this
// process exits, which is what preserves queue semantics. Everything here
// is synchronous, so a concurrent steer() can only land before the spawn
// (steer-tagged pending, picked up here) or after stdin is armed (written
// live) — never in between.
const startSteerableRun = (
  spec: SteerSpec,
  handle: InternalHandle,
  proc: SpawnedProcess,
  invocation: Invocation,
): void => {
  handle.turnsStarted = 0;
  handle.stdinClosed = false;
  const writeTurn = (prompt: string): void => {
    proc.write(spec.encode(prompt));
    handle.startedPrompts.push(prompt);
    handle.turnsStarted++;
  };
  writeTurn(invocation.stdin);
  const queued: InternalHandle["pendingPrompts"] = [];
  for (const entry of handle.pendingPrompts) {
    if (entry.mode !== "steer") {
      queued.push(entry);
      continue;
    }
    writeTurn(entry.prompt);
    handle.steeredCount++;
  }
  handle.pendingPrompts = queued;
};

const runProcess = async (
  runner: Runner,
  handle: InternalHandle,
  invocation: Invocation,
): Promise<void> => {
  const spec = runner.config.agent.steer;
  const proc = runner.spawn(runner.config.agent.binary, invocation.args, {
    stdin: invocation.stdin,
    cwd: handle.workingDir,
    env: runner.config.agent.env(),
    keepStdinOpen: spec !== undefined,
  });
  handle.process = proc;

  // stop() may have set cancelled before we assigned the process
  if (handle.cancelled) {
    proc.kill("SIGINT");
    return;
  }

  const stopEscalation = startStopEscalation(
    proc,
    handle,
    runner.config.stopGraceMs,
  );
  try {
    if (spec !== undefined) startSteerableRun(spec, handle, proc, invocation);

    // Turn-end bookkeeping for steerable runs: once the agent has answered
    // every turn written to its stdin, close stdin so it can finish its
    // queue and exit through the normal exit-code path below. A steer that
    // arrives after this point sees stdinClosed and falls back to
    // pendingPrompts.
    let turnResults = 0;

    for await (const line of proc.stdout) {
      if (handle.status === "stopped") break;
      handle.output.push(line);
      if (spec === undefined || !spec.isTurnEnd(line)) continue;
      turnResults++;
      if (turnResults >= handle.turnsStarted && !handle.stdinClosed) {
        handle.stdinClosed = true;
        proc.closeStdin();
      }
    }

    const result = await proc.exit;
    // Not just "stopped": a failed steer write can mark the run errored
    // while the drain is still attached, and that verdict must not be
    // overwritten by the process's own exit code.
    if (handle.status !== "running") return;
    handle.status = result.exitCode === 0 ? "completed" : "error";
    if (result.exitCode !== 0)
      handle.error = describeFailure(result, runner.config.agent.name);
  } finally {
    stopEscalation();
  }
};

export { defaultSpawn, runProcess };
