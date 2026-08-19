import { type } from "arktype";
import { execa } from "execa";
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

  // execa emits stdout in arbitrary chunks; split into lines so each yielded
  // value is one NDJSON record.
  const stdout = (async function* () {
    let buffer = "";
    let nl: number;
    for await (const chunk of proc) {
      buffer += chunk;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        yield buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.length > 0) yield buffer;
  })();

  const exit = proc.then(
    (r) => ({ exitCode: r.exitCode ?? 0 }),
    (e: unknown) => {
      if (!ExecaError.allows(e)) return { exitCode: null };
      return { exitCode: e.exitCode ?? null, signal: e.signal };
    },
  );

  // A kill aimed at an already-exited subprocess is worse than useless with
  // killDescendants: the Windows path (taskkill /PID <pid> /T /F) never
  // checks that the pid still belongs to us, and Windows recycles pids
  // quickly — a stale tree-kill can terminate an unrelated process (the
  // user's real goose agent, say) plus its whole subtree. execa's live
  // subprocess keeps no synchronous exit state (exitCode stays undefined
  // and the instance is not an EventEmitter), so settle a flag off the
  // promise instead — settled strictly implies exited, so the
  // SIGINT → SIGTERM → SIGKILL escalation stays fully intact for a live —
  // even a signal-trapping — process, while a retired pid is never
  // signalled again.
  let exited = false;
  const markExited = (): void => {
    exited = true;
  };
  void proc.then(markExited, markExited);

  const kill = (signal: NodeJS.Signals = "SIGINT"): void => {
    if (!exited) proc.kill(signal);
  };

  return { pid, kill, stdout, exit };
};

// A self-rearming interval polls handle.status in grace-sized windows so a
// stop() issued mid-run is noticed within one window; once stopped, each
// elapsed window escalates the kill signal — SIGTERM, then uncatchable
// SIGKILL — so a process that traps SIGINT can't park runProcess here forever,
// holding a runner slot and leaking its detached process group. proc.exit is
// awaited once (not re-wrapped per window) so polling doesn't accumulate
// dangling .then handlers on the same promise.
//
// Windows has no POSIX signals: per Node's docs, kill() with SIGINT, SIGTERM,
// or SIGKILL unconditionally terminates the target at once, so the graceful
// ladder below collapses into a single hard kill — sessions still stop, but
// the agent gets no chance to flush state. execa routes each kill() to the
// right mechanism per platform, so no change is needed here.
const awaitExit = async (
  proc: SpawnedProcess,
  handle: InternalHandle,
  graceMs: number,
): Promise<ProcessResult> => {
  let escalated = false;
  const poll = setInterval(() => {
    if (handle.status !== "stopped") return;
    if (escalated) {
      clearInterval(poll);
      proc.kill("SIGKILL");
      return;
    }
    escalated = true;
    proc.kill("SIGTERM");
  }, graceMs);

  try {
    return await proc.exit;
  } finally {
    clearInterval(poll);
  }
};

const runProcess = async (
  runner: Runner,
  handle: InternalHandle,
  invocation: Invocation,
): Promise<void> => {
  const proc = runner.spawn(runner.config.agent.binary, invocation.args, {
    stdin: invocation.stdin,
    cwd: handle.workingDir,
    env: runner.config.agent.env(),
  });
  handle.process = proc;

  // stop() may have set cancelled before we assigned the process
  if (handle.cancelled) {
    proc.kill("SIGINT");
    return;
  }

  for await (const line of proc.stdout) {
    if (handle.status === "stopped") break;
    handle.output.push(line);
  }

  const result = await awaitExit(proc, handle, runner.config.stopGraceMs);
  if (handle.status === "stopped") return;
  handle.status = result.exitCode === 0 ? "completed" : "error";
  if (result.exitCode !== 0)
    handle.error = describeFailure(result, runner.config.agent.name);
};

export { defaultSpawn, runProcess };
