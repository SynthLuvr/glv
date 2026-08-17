import { type } from "arktype";
import { execa } from "execa";
import type {
  ClaudeInvocation,
  InternalHandle,
  ProcessResult,
  Runner,
  SpawnedProcess,
  SpawnFn,
} from "./types.js";

const describeFailure = (result: ProcessResult): string => {
  if (result.signal !== undefined)
    return `claude killed by signal ${result.signal}`;
  if (result.exitCode === null) return "claude process exited unexpectedly";
  return `claude exited with code ${result.exitCode}`;
};

const ExecaError = type({
  "exitCode?": "number | undefined",
  "signal?": "string | undefined",
});

const defaultSpawn: SpawnFn = (binary, args, opts) => {
  const proc = execa(binary, args, {
    input: opts.stdin,
    cwd: opts.cwd,
    // claude gates a directory it has never seen behind an interactive "do
    // you trust the files in this folder?" dialog that a headless --print run
    // can never answer, and drops project-scoped settings until it is
    // accepted; CLAUDE_CODE_SANDBOXED short-circuits both to trusted. It only
    // marks the directory trusted — what claude may do there is still bounded
    // by the permission mode. execa extends process.env, so the rest of the
    // environment is still inherited.
    env: { CLAUDE_CODE_SANDBOXED: "1" },
    // killDescendants makes execa reap the whole process tree on kill —
    // process.kill(-pid) on Unix, taskkill /T /F on Windows — so claude's
    // grandchildren (tool shells, MCP servers) are torn down too.
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
//
// Windows has no POSIX signals: per Node's docs, kill() with SIGINT, SIGTERM,
// or SIGKILL unconditionally terminates the target at once, so the graceful
// ladder below collapses into a single hard kill — sessions still stop, but
// claude gets no chance to flush state. execa routes each kill() to the right
// mechanism per platform, so no change is needed here.
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
  invocation: ClaudeInvocation,
): Promise<void> => {
  const proc = runner.spawn(runner.config.claudeBinary, invocation.args, {
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
