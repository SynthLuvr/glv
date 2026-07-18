import { type } from "arktype";
import { execa } from "execa";
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
  } catch {
    // Already exited.
  }
};

// Resolve with the awaited value, or undefined when `promise` doesn't settle
// within `timeoutMs`. The timer is cleared the moment the promise resolves so
// a long-lived `proc.exit` can't accumulate dangling timers.
const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

const describeFailure = (result: ProcessResult): string => {
  if (result.signal !== undefined)
    return `goose killed by signal ${result.signal}`;
  if (result.exitCode === null) return "goose process exited unexpectedly";
  return `goose exited with code ${result.exitCode}`;
};

const ExecaError = type({
  "exitCode?": "number | undefined",
  "signal?": "string | undefined",
});

const defaultSpawn: SpawnFn = (binary, args, opts) => {
  const proc = execa(binary, args, {
    input: opts.stdin,
    cwd: opts.cwd,
    detached: true,
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

  const kill = (signal: string = "SIGINT"): void => {
    killProcessGroup(pid, signal);
  };

  return { pid, kill, stdout, exit };
};

// Poll proc.exit in grace-sized windows. A stop() issued mid-run is noticed
// within one window; once stopped, each elapsed window escalates the kill
// signal — SIGTERM, then uncatchable SIGKILL — so a process that traps SIGINT
// can't park runProcess here forever, holding a runner slot and leaking its
// detached process group.
const awaitExit = async (
  proc: SpawnedProcess,
  handle: InternalHandle,
  graceMs: number,
): Promise<ProcessResult> => {
  let escalated = false;
  for (;;) {
    const result = await withTimeout(proc.exit, graceMs);
    if (result !== undefined) return result;
    if (handle.status !== "stopped") continue;
    if (escalated) {
      proc.kill("SIGKILL");
      return proc.exit;
    }
    escalated = true;
    proc.kill("SIGTERM");
  }
};

const runProcess = async (
  runner: Runner,
  handle: InternalHandle,
  invocation: GooseInvocation,
): Promise<void> => {
  const proc = runner.spawn(runner.config.gooseBinary, invocation.args, {
    stdin: invocation.stdin,
    cwd: handle.workingDir,
  });
  handle.process = proc;

  for await (const line of proc.stdout) {
    if (handle.status === "stopped") break;
    handle.lines.push(line);
    const excess = handle.lines.length - runner.config.maxLines;
    if (excess > 0) {
      handle.lines.splice(0, excess);
      handle.droppedLines += excess;
    }
    handle.onLine?.(line);
  }

  const result = await awaitExit(proc, handle, runner.config.stopGraceMs);
  if (handle.status === "stopped") return;
  handle.status = result.exitCode === 0 ? "completed" : "error";
  if (result.exitCode !== 0) handle.error = describeFailure(result);
};

export { defaultSpawn, killProcessGroup, runProcess };
