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
    // killDescendants makes execa reap the whole process tree on kill —
    // process.kill(-pid) on Unix, taskkill /T /F on Windows — so goose's
    // grandchildren (tool shells, stdio extensions) are torn down too.
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

  const kill = (signal: NodeJS.Signals = "SIGINT"): void => {
    proc.kill(signal);
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
  if (result.exitCode !== 0) handle.error = describeFailure(result);
};

export { defaultSpawn, runProcess };
