import { type } from "arktype";
import { execa } from "execa";
import { debug, warn } from "../log.js";
import type {
  GooseInvocation,
  InternalHandle,
  ProcessResult,
  Runner,
  SpawnedProcess,
  SpawnFn,
} from "./types.js";

// Kill the whole process group so grandchildren (tool shells, stdio
// extensions) are reaped too. Runs spawn detached, so the goose PID doubles as
// the group leader ID.
const killProcessGroup = (pid: number, signal: string = "SIGINT"): void => {
  // -1 is the unknown-PID sentinel; negating it would target PID 1 (init).
  if (pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // Usually the process already exited; surface at debug in case the
    // failure is a permissions issue worth investigating.
    debug("runner", err);
  }
};

const ExecaError = type({
  "exitCode?": "number | undefined",
  "signal?": "string | undefined",
  "stderr?": "string | undefined",
  "shortMessage?": "string | undefined",
  "originalMessage?": "string | undefined",
});

// A missing or non-executable binary surfaces as an ENOENT/EACCES on the
// underlying spawn; execa folds it into originalMessage/shortMessage. Treat
// those as a distinct "could not start goose" failure rather than a crash.
const isSpawnFailure = (e: {
  originalMessage?: string;
  shortMessage?: string;
}): boolean => {
  const msg = `${e.originalMessage ?? ""} ${e.shortMessage ?? ""}`;
  return /ENOENT|EACCES|spawn|not found|permission/i.test(msg);
};

// execa buffers stderr internally even while stdout is iterated externally
// (verified: the buffered copy survives a non-zero exit and a SIGTERM kill),
// so we read diagnostics from the result/error rather than racing a second
// consumer that would split the stream.
const defaultSpawn: SpawnFn = (binary, args, opts) => {
  const proc = execa(binary, args, {
    input: opts.stdin,
    cwd: opts.cwd,
    detached: true,
  });
  const pid = proc.pid ?? -1;

  // execa emits stdout in arbitrary chunks; split into lines so each yielded
  // value is one NDJSON record.
  const stdout = splitLines(proc);

  // On rejection (non-zero exit or a spawn failure) execa carries the exit
  // code, signal, buffered stderr and a short message. Capture all of them so
  // describeFailure can surface *why* goose died instead of a bare exit code.
  const exit = proc.then(
    (r): ProcessResult => ({ exitCode: r.exitCode ?? 0, stderr: r.stderr }),
    (e: unknown): ProcessResult => {
      if (!ExecaError.allows(e)) return { exitCode: null };
      return {
        exitCode: e.exitCode ?? null,
        signal: e.signal,
        stderr: e.stderr,
        message: e.originalMessage ?? e.shortMessage,
        spawnFailed: isSpawnFailure(e),
      };
    },
  );

  const kill = (signal: string = "SIGINT"): void => {
    killProcessGroup(pid, signal);
  };

  return { pid, kill, stdout, exit };
};

const splitLines = async function* (
  stream: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  let buffer = "";
  let nl: number;
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : String(chunk);
    while ((nl = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.length > 0) yield buffer;
};

// A self-rearming interval polls handle.status in grace-sized windows so a
// stop() issued mid-run is noticed within one window; once stopped, each
// elapsed window escalates the kill signal — SIGTERM, then uncatchable
// SIGKILL — so a process that traps SIGINT can't park runProcess here forever,
// holding a runner slot and leaking its detached process group. proc.exit is
// awaited once (not re-wrapped per window) so polling doesn't accumulate
// dangling .then handlers on the same promise.
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

type FirstOutput =
  | { kind: "line"; value: string }
  | { kind: "timeout" }
  | { kind: "ended"; result: ProcessResult };

// Race goose's first output line against a startup deadline and the process
// exit. "timeout" means goose hung at startup (no output) and should restart;
// "ended" means it exited/crashed before emitting anything; "line" means it is
// alive and streaming. The deadline timer is unref'd so it never blocks exit
// and always cleared so it can't leak past the first line.
const raceFirstOutput = (
  iter: AsyncIterator<string>,
  exit: Promise<ProcessResult>,
  timeoutMs: number,
): Promise<FirstOutput> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer)
      (timer as { unref: () => void }).unref();
  });
  // A spawn failure (ENOENT) rejects the stdout iterator; treat that as
  // "ended" and let the already-settled exit result carry the cause.
  const next = iter.next().then(
    (result) => ({
      kind: "line" as const,
      value: result.value as string,
      done: result.done === true,
    }),
    () => ({ kind: "stream-error" as const }),
  );
  return Promise.race([next, timeout]).then((winner) => {
    if (timer !== undefined) clearTimeout(timer);
    if (winner === "timeout") return { kind: "timeout" };
    if (winner.kind === "line" && !winner.done)
      return { kind: "line", value: winner.value };
    // stdout closed/errored before a usable line: fall through to the exit.
    return exit.then((result) => ({ kind: "ended", result }));
  });
};

type AttemptOutcome =
  | { kind: "completed" }
  | { kind: "stopped" }
  | { kind: "retry"; stderr?: string }
  | { kind: "failed"; result: ProcessResult };

const runAttempt = async (
  runner: Runner,
  handle: InternalHandle,
  invocation: GooseInvocation,
): Promise<AttemptOutcome> => {
  const proc = runner.spawn(runner.config.gooseBinary, invocation.args, {
    stdin: invocation.stdin,
    cwd: handle.workingDir,
  });
  handle.process = proc;

  // stop() may have set cancelled before we assigned the process
  if (handle.cancelled) {
    proc.kill("SIGINT");
    return { kind: "stopped" };
  }

  const iter = proc.stdout[Symbol.asyncIterator]();
  const first = await raceFirstOutput(
    iter,
    proc.exit,
    runner.config.startupTimeoutMs,
  );

  if (first.kind === "timeout") {
    warn("runner", {
      message: `goose produced no output within ${runner.config.startupTimeoutMs}ms; restarting`,
      sessionId: handle.sessionId,
      pid: proc.pid,
    });
    proc.kill("SIGTERM");
    // Reap the detached group so a wedged goose can't linger across restarts,
    // and salvage any stderr it printed before hanging.
    const killed = await proc.exit.catch((err) => {
      debug("runner", err);
      return undefined;
    });
    return { kind: "retry", stderr: killed?.stderr };
  }

  if (first.kind === "line") {
    if (handle.status === "stopped") {
      proc.kill("SIGINT");
      return { kind: "stopped" };
    }
    handle.output.push(first.value);
  }
  // first.kind === "ended": goose exited before any output — nothing to stream.

  // Subsequent lines have no deadline: a run that started streaming is alive.
  // The stdout iterator rejects on a non-zero exit, so swallow that and let
  // awaitExit below capture the structured result (with stderr).
  for (;;) {
    let step: IteratorResult<string>;
    try {
      step = await iter.next();
    } catch {
      break;
    }
    if (step.done) break;
    if (handle.status === "stopped") break;
    handle.output.push(step.value);
  }

  const result = await awaitExit(proc, handle, runner.config.stopGraceMs);
  if (handle.status === "stopped") return { kind: "stopped" };
  if (result.exitCode === 0) return { kind: "completed" };
  return { kind: "failed", result };
};

// Keep error detail short enough to fit in a status payload without truncating
// the usually-informative final lines.
const STDERR_DETAIL_MAX = 2000;

const trimStderr = (text: string | undefined): string => {
  if (text === undefined) return "";
  const trimmed = text.trim();
  if (trimmed.length <= STDERR_DETAIL_MAX) return trimmed;
  return `…${trimmed.slice(-STDERR_DETAIL_MAX)}`;
};

const describeFailure = (result: ProcessResult): string => {
  if (result.spawnFailed === true)
    return `goose binary failed to start: ${result.message ?? "unknown error"}`;
  if (result.signal !== undefined)
    return `goose killed by signal ${result.signal}`;
  if (result.exitCode === null) return "goose process exited unexpectedly";
  const base = `goose exited with code ${result.exitCode}`;
  const detail = trimStderr(result.stderr);
  return detail === "" ? base : `${base} — ${detail}`;
};

const startupTimeoutError = (
  timeoutMs: number,
  attempts: number,
  stderr: string | undefined,
): string => {
  const base = `goose produced no output after ${attempts} attempt${attempts === 1 ? "" : "s"} (${timeoutMs}ms each)`;
  const detail = trimStderr(stderr);
  return detail === "" ? base : `${base} — ${detail}`;
};

// Runs goose, restarting it when it hangs before emitting its first output
// line (up to maxStartupRetries). A process that streams anything is
// considered alive and never restarted; a non-zero exit is a real failure
// surfaced with captured stderr so the user knows *why* it died.
const runProcess = async (
  runner: Runner,
  handle: InternalHandle,
  invocation: GooseInvocation,
): Promise<void> => {
  const maxAttempts = runner.config.maxStartupRetries + 1;
  for (let attempt = 1; ; attempt++) {
    const outcome = await runAttempt(runner, handle, invocation);

    if (outcome.kind === "stopped") return;
    if (outcome.kind === "completed") {
      handle.status = "completed";
      return;
    }
    if (outcome.kind === "failed") {
      handle.status = "error";
      handle.error = describeFailure(outcome.result);
      warn("runner", {
        message: handle.error,
        sessionId: handle.sessionId,
        exitCode: outcome.result.exitCode,
        spawnFailed: outcome.result.spawnFailed === true,
        stderr: outcome.result.stderr,
      });
      return;
    }

    // retry: a hung startup. Restart unless attempts are exhausted.
    if (attempt >= maxAttempts) {
      handle.status = "error";
      handle.error = startupTimeoutError(
        runner.config.startupTimeoutMs,
        attempt,
        outcome.stderr,
      );
      warn("runner", {
        message: handle.error,
        sessionId: handle.sessionId,
        stderr: outcome.stderr,
      });
      return;
    }
  }
};

export { defaultSpawn, runProcess };
