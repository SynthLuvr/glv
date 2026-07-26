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

// Node's Timeout exposes unref; the DOM lib's setTimeout returns a number, so
// guard before calling it. Detaching the timer keeps it from blocking exit.
const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (typeof timer === "object" && timer !== null && "unref" in timer)
    (timer as { unref: () => void }).unref();
};

const ExecaError = type({
  "exitCode?": "number | undefined",
  "signal?": "string | undefined",
  "stderr?": "string | undefined",
  "shortMessage?": "string | undefined",
  "originalMessage?": "string | undefined",
});

// A missing or non-executable binary surfaces as ENOENT/EACCES, which execa
// folds into originalMessage/shortMessage. Treat that as a distinct "could not
// start goose" failure rather than a crash with an exit code.
const isSpawnFailure = (e: {
  originalMessage?: string;
  shortMessage?: string;
}): boolean =>
  /ENOENT|EACCES|spawn|not found|permission/i.test(
    `${e.originalMessage ?? ""} ${e.shortMessage ?? ""}`,
  );

// Splits an async stream of string chunks into newline-delimited lines.
const splitLines = async function* (
  stream: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  let nl: number;
  for await (const chunk of stream) {
    buffer += chunk;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.length > 0) yield buffer;
};

// execa buffers stderr internally even while stdout is iterated externally
// (the buffered copy survives a non-zero exit and a SIGTERM kill), so we read
// diagnostics from the result/error rather than racing a second consumer that
// would split the stream.
const defaultSpawn: SpawnFn = (binary, args, opts) => {
  const proc = execa(binary, args, {
    input: opts.stdin,
    cwd: opts.cwd,
    detached: true,
  });
  const pid = proc.pid ?? -1;

  const stdout = splitLines(proc);

  // On rejection execa carries exit code, signal, buffered stderr and a short
  // message; capture all of them so describeFailure can show *why* goose died.
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

// Reads the first output line, settling to "closed" on end-of-stream or a
// spawn failure (ENOENT rejects the iterator) so the caller falls back to the
// exit result for the cause.
const nextFirstLine = async (
  iter: AsyncIterator<string>,
): Promise<{ kind: "line"; value: string } | { kind: "closed" }> => {
  try {
    const result = await iter.next();
    return result.done
      ? { kind: "closed" }
      : { kind: "line", value: result.value as string };
  } catch {
    return { kind: "closed" };
  }
};

// Races goose's first output line against a startup deadline and the process
// exit: "timeout" means it hung at startup and should restart, "ended" means it
// exited before emitting anything, "line" means it is alive and streaming.
const raceFirstOutput = async (
  iter: AsyncIterator<string>,
  exit: Promise<ProcessResult>,
  timeoutMs: number,
): Promise<FirstOutput> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    unrefTimer(timer);
  });
  const first = await Promise.race([nextFirstLine(iter), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (first === "timeout") return { kind: "timeout" };
  if (first.kind === "line") return { kind: "line", value: first.value };
  return { kind: "ended", result: await exit };
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

  // stop() may have set cancelled before we assigned the process.
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
    // Reap the detached group so a wedged goose can't linger, and salvage any
    // stderr it printed before hanging.
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

  // A run that started streaming is alive, so later lines have no deadline.
  // The iterator rejects on a non-zero exit; swallow that and let awaitExit
  // capture the structured result with stderr.
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

// Caps stderr detail so it fits in a status payload, keeping the usually
// informative final lines.
const STDERR_DETAIL_MAX = 2000;

const trimStderr = (text: string | undefined): string => {
  if (text === undefined) return "";
  const trimmed = text.trim();
  return trimmed.length <= STDERR_DETAIL_MAX
    ? trimmed
    : `…${trimmed.slice(-STDERR_DETAIL_MAX)}`;
};

const withDetail = (base: string, stderr: string | undefined): string => {
  const detail = trimStderr(stderr);
  return detail === "" ? base : `${base} — ${detail}`;
};

const describeFailure = (result: ProcessResult): string => {
  if (result.spawnFailed === true)
    return `goose binary failed to start: ${result.message ?? "unknown error"}`;
  if (result.signal !== undefined)
    return `goose killed by signal ${result.signal}`;
  if (result.exitCode === null) return "goose process exited unexpectedly";
  return withDetail(`goose exited with code ${result.exitCode}`, result.stderr);
};

const startupTimeoutError = (
  timeoutMs: number,
  attempts: number,
  stderr: string | undefined,
): string =>
  withDetail(
    `goose produced no output after ${attempts} attempt${attempts === 1 ? "" : "s"} (${timeoutMs}ms each)`,
    stderr,
  );

const markError = (
  handle: InternalHandle,
  message: string,
  context: Record<string, unknown>,
): void => {
  handle.status = "error";
  handle.error = message;
  warn("runner", { message, sessionId: handle.sessionId, ...context });
};

// Runs goose, restarting it when it hangs before its first output line (up to
// maxStartupRetries). A process that streams anything is alive and never
// restarted; a non-zero exit fails immediately with captured stderr.
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
      markError(handle, describeFailure(outcome.result), {
        exitCode: outcome.result.exitCode,
        spawnFailed: outcome.result.spawnFailed === true,
        stderr: outcome.result.stderr,
      });
      return;
    }

    // retry: a hung startup — restart unless attempts are exhausted.
    if (attempt >= maxAttempts) {
      markError(
        handle,
        startupTimeoutError(
          runner.config.startupTimeoutMs,
          attempt,
          outcome.stderr,
        ),
        { stderr: outcome.stderr },
      );
      return;
    }
  }
};

export { defaultSpawn, runProcess };
