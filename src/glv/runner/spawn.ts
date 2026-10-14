import { type } from "arktype";
import { execa } from "execa";
import { detectStopNotice } from "../stop-reason.js";
import type {
  InternalHandle,
  Invocation,
  ProcessResult,
  Runner,
  SpawnedProcess,
  SpawnFn,
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
    input: opts.stdin,
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

  // execa v9+ async iteration already yields one newline-stripped line
  // per iteration, so stdout needs no raw-chunk buffering/splitting here.
  return { pid, kill, stdout: proc, exit };
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

// execa's stream iterator rejects once the final line has been yielded
// whenever the process exits non-zero — claude does exactly that after
// printing its failure record. The record is already buffered by then, so
// the drain returns the error instead of throwing and the exit verdict
// below still runs; runProcess rethrows it only when the exit result
// carries no code, so a spawn failure keeps its original message.
const drainStdout = async (
  proc: SpawnedProcess,
  handle: InternalHandle,
): Promise<unknown> => {
  try {
    for await (const line of proc.stdout) {
      if (handle.status === "stopped") break;
      handle.output.push(line);
    }
  } catch (err) {
    return err;
  }
};

// A provider refusal announced on the run's stream outranks the exit
// code: goose 1.45.0 prints its usage-limit error record and still exits
// 0, so the code alone would read as a clean finish — the silent stop
// this corrects. A detected refusal becomes a run error carrying the
// notice (reset time included); exit codes keep explaining themselves
// when the stream said nothing.
const settleRun = (
  handle: InternalHandle,
  result: ProcessResult,
  firstSeq: number,
): void => {
  const notice = detectStopNotice(handle.output.drain(firstSeq).lines);
  if (notice !== undefined) {
    handle.status = "error";
    handle.error = notice;
    handle.stopNotice = notice;
  } else {
    handle.status = result.exitCode === 0 ? "completed" : "error";
    if (result.exitCode !== 0)
      handle.error = describeFailure(result, handle.agent.name);
  }
};

const runProcess = async (
  runner: Runner,
  handle: InternalHandle,
  invocation: Invocation,
): Promise<void> => {
  // The handle's own agent spawns the process — one pool, many agents.
  const proc = runner.spawn(handle.agent.binary, invocation.args, {
    stdin: invocation.stdin,
    cwd: handle.workingDir,
    env: handle.agent.env(),
  });
  handle.process = proc;

  // stop() may have set cancelled before we assigned the process
  if (handle.cancelled) {
    proc.kill("SIGINT");
    return;
  }

  // Only this invocation's lines: a chained run keeps one buffer across
  // its prompts, so a refusal announced by an earlier link must not
  // colour the verdict on a later one.
  const firstSeq = handle.output.drain(0).nextSeq;

  const stopEscalation = startStopEscalation(
    proc,
    handle,
    runner.config.stopGraceMs,
  );
  try {
    const drainError = await drainStdout(proc, handle);
    const result = await proc.exit;
    if (handle.status === "stopped") return;
    if (result.exitCode === null && drainError !== undefined) throw drainError;
    settleRun(handle, result, firstSeq);
  } finally {
    stopEscalation();
  }
};

export { defaultSpawn, runProcess };
