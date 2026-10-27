import { type } from "arktype";
import { execa } from "execa";
import { truncate } from "../format/text.js";
import { detectStopNotice } from "../stop-reason.js";
import { reapDescendantsOnSettle } from "./reap.js";
import type {
  InternalHandle,
  Invocation,
  ProcessResult,
  Runner,
  SpawnedProcess,
  SpawnFn,
} from "./types.js";

// A failure verdict suffixed with the captured stderr tail, if any.
const withStderrTail = (message: string, tail: string): string =>
  tail === "" ? message : `${message} — last stderr:\n${tail}`;

const describeFailure = (
  result: ProcessResult,
  name: string,
  stderrTail: string,
): string => {
  const verdict =
    result.signal !== undefined
      ? `${name} killed by signal ${result.signal}`
      : result.exitCode === null
        ? `${name} process exited unexpectedly`
        : `${name} exited with code ${result.exitCode}`;
  return withStderrTail(verdict, stderrTail);
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

  // killDescendants only fires inside kill(), so an agent that dies on
  // its own would leak its tree — reap at settle too (#379).
  reapDescendantsOnSettle(proc);

  // execa exposes no synchronous exit state, and its Windows tree-kill
  // (taskkill /PID <pid> /T /F) never verifies the pid still belongs to us
  // — dangerous where pids recycle quickly. Track liveness off the settled
  // promise so a retired pid is never signalled again. (The settle reap
  // above is exempt: a group id stays reserved while any member lives, so
  // it cannot hit a recycled pid.)
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
  return {
    pid,
    kill,
    stdout: proc,
    stderr: proc.iterable({ from: "stderr" }),
    exit,
  };
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

// A bounded tail of the agent's stderr. The agents pipe diagnostics to
// stderr (a Rust abort message, a node OOM, MCP negotiation errors) that
// execa captures but nothing read; a few trailing lines each capped in
// length explain a crash without unbounded memory.
const STDERR_TAIL_LINES = 10;
const STDERR_LINE_MAX = 400;

const createStderrTail = () => {
  const lines: string[] = [];
  return {
    push: (line: string): void => {
      lines.push(truncate(line, STDERR_LINE_MAX));
      if (lines.length > STDERR_TAIL_LINES) lines.shift();
    },
    text: (): string => lines.join("\n"),
  };
};

// Drains stderr into the tail for as long as the process lives. Stream
// errors (the process died) surface through the exit result instead —
// only the captured text matters here.
const drainStderr = async (
  proc: SpawnedProcess,
  tail: { push: (line: string) => void },
): Promise<void> => {
  try {
    for await (const line of proc.stderr) tail.push(line);
  } catch {
    // exit/exit-code reporting owns failure verdicts
  }
};

// Run lifecycle lines — the only place a spawn or exit is otherwise
// visible is the in-memory registry; the log deserves the pid and
// verdict too.
const runLabel = (handle: InternalHandle): string =>
  `${handle.agent.name} session ${handle.sessionId}`;

const describeExit = (result: ProcessResult): string =>
  result.signal !== undefined
    ? `signal ${result.signal}`
    : result.exitCode === null
      ? "no exit status"
      : `exit code ${result.exitCode}`;

const logRunEvent = (handle: InternalHandle, event: string): void => {
  console.log(`run: ${runLabel(handle)} ${event}`);
};

// Records the diagnostic and starts the kill ladder for a run whose
// agent stayed silent past the startup deadline.
const failStalledStartup = (
  runner: Runner,
  handle: InternalHandle,
  proc: SpawnedProcess,
  stderrTail: string,
): void => {
  const secs = runner.config.startupTimeoutMs / 1000;
  const message =
    `${handle.agent.name} run on session ${handle.sessionId} ` +
    `produced no output within ${secs}s of starting and was killed — ` +
    "the agent likely stalled during startup";
  handle.status = "error";
  handle.error = withStderrTail(message, stderrTail);
  console.error(`run: ${runLabel(handle)} killed by the startup watchdog`);
  proc.kill("SIGTERM");
};

// The startup watchdog: a run whose agent emits not one stdout line
// within the deadline is failed and killed. Without it, an agent that
// stalls during startup (a dead MCP extension it waits on forever) parks
// the drain loop permanently — the handle reads "running" forever and
// starves the concurrency pool. The first stdout line disarms it: any
// output proves the agent got past startup, and the run may take as long
// as it likes from there. The kill mirrors the stop ladder — SIGTERM,
// then SIGKILL after the grace window — with killDescendants reaping the
// whole tree.
const armStartupWatchdog = (
  runner: Runner,
  handle: InternalHandle,
  proc: SpawnedProcess,
  stderrTail: () => string,
): { cancel: () => void; fired: () => boolean } => {
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let didFire = false;
  const timer = setTimeout(() => {
    if (handle.status !== "running") return;
    didFire = true;
    failStalledStartup(runner, handle, proc, stderrTail());
    killTimer = setTimeout(
      () => proc.kill("SIGKILL"),
      runner.config.stopGraceMs,
    );
  }, runner.config.startupTimeoutMs);
  return {
    cancel: () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    },
    fired: () => didFire,
  };
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
  onFirstLine: () => void,
): Promise<unknown> => {
  let spoke = false;
  // Returns false when the run was stopped mid-stream — the drain stops
  // without buffering that line.
  const ingest = (line: string): boolean => {
    if (!spoke) {
      spoke = true;
      onFirstLine();
    }
    if (handle.status === "stopped") return false;
    handle.output.push(line);
    return true;
  };
  try {
    for await (const line of proc.stdout) if (!ingest(line)) break;
  } catch (err) {
    return err;
  }
};

// A provider refusal announced on the run's stream outranks the exit
// code: goose 1.45.0 prints its usage-limit error record and still exits
// 0, so the code alone would read as a clean finish — the silent stop
// this corrects. A detected refusal becomes a run error carrying the
// notice (reset time included); otherwise exit codes explain themselves.
const settleRun = (
  handle: InternalHandle,
  result: ProcessResult,
  firstSeq: number,
  stderrTail: string,
): void => {
  const notice = detectStopNotice(handle.output.drain(firstSeq).lines);
  if (notice !== undefined) {
    handle.status = "error";
    handle.error = notice;
    handle.stopNotice = notice;
  } else {
    handle.status = result.exitCode === 0 ? "completed" : "error";
    if (result.exitCode !== 0)
      handle.error = describeFailure(result, handle.agent.name, stderrTail);
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

  logRunEvent(handle, `started (pid ${proc.pid})`);
  const stderrTail = createStderrTail();
  const stderrDone = drainStderr(proc, stderrTail);
  const stopEscalation = startStopEscalation(
    proc,
    handle,
    runner.config.stopGraceMs,
  );
  const watchdog = armStartupWatchdog(runner, handle, proc, stderrTail.text);
  try {
    const drainError = await drainStdout(proc, handle, () => watchdog.cancel());
    const result = await proc.exit;
    watchdog.cancel();
    // The stderr iterable ends with the process; awaiting it after the
    // exit verdict guarantees the tail holds everything the agent said.
    await stderrDone;
    logRunEvent(handle, `ended (pid ${proc.pid}, ${describeExit(result)})`);
    if (handle.status === "stopped") return;
    // The watchdog already recorded its diagnostic and owns the kill;
    // "killed by signal SIGTERM" would only obscure why it fired.
    if (watchdog.fired()) return;
    if (result.exitCode === null && drainError !== undefined) throw drainError;
    settleRun(handle, result, firstSeq, stderrTail.text());
  } finally {
    stopEscalation();
    watchdog.cancel();
  }
};

export { defaultSpawn, runProcess };
