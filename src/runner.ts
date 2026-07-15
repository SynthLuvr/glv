import { type } from "arktype";
import { execa } from "execa";
import PQueue from "p-queue";

type RunnerConfig = {
  maxConcurrent: number;
  gooseBinary: string;
};

const RunnerConfigSchema = type({
  maxConcurrent: "number.integer >= 1",
  gooseBinary: "string >= 1",
});

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxConcurrent: 6,
  gooseBinary: "goose",
};

// goose reads instructions from stdin via `-i -` (the `-` is the stdin marker),
// never as a `-t` argument — this sidesteps the OS argument-length limit and
// all shell-quoting concerns, and works for arbitrarily long prompts.
const STREAM_FLAGS = ["--output-format", "stream-json", "-i", "-"];

type GooseInvocation = {
  args: string[];
  stdin: string;
};

const resumeInvocation = (
  sessionId: string,
  prompt: string,
): GooseInvocation => ({
  args: ["run", "-r", "--session-id", sessionId, ...STREAM_FLAGS],
  stdin: prompt,
});

const newSessionInvocation = (
  name: string,
  prompt: string,
): GooseInvocation => ({
  args: ["run", ...STREAM_FLAGS, "-n", name],
  stdin: prompt,
});

const makeRunnerConfig = (
  maxConcurrent: number,
  gooseBinary: string,
): RunnerConfig => {
  const result = RunnerConfigSchema({ maxConcurrent, gooseBinary });
  if (result instanceof type.errors)
    throw new Error(`Invalid runner configuration: ${result.summary}`);
  return result;
};

// ---------------------------------------------------------------------------
// Run lifecycle (M1)
// ---------------------------------------------------------------------------

type RunStatus = "queued" | "running" | "completed" | "stopped" | "error";

/** Public snapshot of a run's state. */
type RunHandle = {
  readonly sessionId: string;
  readonly prompt: string;
  status: RunStatus;
  /** Approximate position in the queue (undefined when running or done). */
  queuePosition: number | undefined;
  /** Lines streamed from goose stdout so far. */
  lines: string[];
  /** Error message when status is "error". */
  error: string | undefined;
};

type ProcessResult = {
  exitCode: number | null;
  signal?: string;
};

/** A running subprocess — a narrow view of execa's return value. */
type SpawnedProcess = {
  pid: number;
  kill: (signal?: string) => void;
  stdout: AsyncIterable<string>;
  exit: Promise<ProcessResult>;
};

/**
 * Factory that spawns a subprocess.  The default uses execa; tests inject a
 * fake to avoid spawning real goose processes.
 */
type SpawnFn = (
  binary: string,
  args: string[],
  opts: { stdin: string; cwd: string },
) => SpawnedProcess;

type EnqueueOptions = {
  onLine?: (line: string) => void;
  onStatus?: (handle: RunHandle) => void;
};

type InternalHandle = RunHandle & {
  readonly workingDir: string;
  cancelled: boolean;
  process: SpawnedProcess | undefined;
  onLine: ((line: string) => void) | undefined;
  onStatus: ((handle: RunHandle) => void) | undefined;
};

type Runner = {
  readonly config: RunnerConfig;
  readonly queue: PQueue;
  readonly registry: Map<string, InternalHandle>;
  readonly spawn: SpawnFn;
};

// Kill the entire process group so grandchildren (stdio extensions, tool
// shells) are reaped, not just the direct goose child.  Runs spawn detached so
// the goose PID doubles as the group ID.
const killProcessGroup = (pid: number, signal: string = "SIGINT"): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // Process may have already exited — ignore.
  }
};

const describeFailure = (result: ProcessResult): string => {
  if (result.signal !== undefined)
    return `goose killed by signal ${result.signal}`;
  if (result.exitCode === null) return "goose process exited unexpectedly";
  return `goose exited with code ${result.exitCode}`;
};

// Reads status without control-flow narrowing so that checks against "stopped"
// remain valid even after an earlier assignment like `handle.status = "running"`.
// The runner mutates status from stop() between reads, which TypeScript's
// narrowing cannot model.
const isStopped = (handle: { status: RunStatus }): boolean =>
  handle.status === "stopped";

const defaultSpawn: SpawnFn = (binary, args, opts) => {
  const proc = execa(binary, args, {
    input: opts.stdin,
    cwd: opts.cwd,
    detached: true,
  });
  const pid = proc.pid ?? -1;

  // execa yields stdout in arbitrary chunks; split into individual lines so
  // downstream NDJSON parsing gets one record per iteration.
  const stdout = (async function* () {
    let buffer = "";
    for await (const chunk of proc) {
      buffer += chunk;
      let nl: number;
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
      const err = e as { exitCode?: number; signal?: string };
      return { exitCode: err.exitCode ?? null, signal: err.signal };
    },
  );

  const kill = (signal: string = "SIGINT"): void => {
    killProcessGroup(pid, signal);
  };

  return { pid, kill, stdout, exit };
};

const createRunner = (
  config: RunnerConfig = DEFAULT_RUNNER_CONFIG,
  spawn: SpawnFn = defaultSpawn,
): Runner => {
  const queue = new PQueue({ concurrency: config.maxConcurrent });
  const registry = new Map<string, InternalHandle>();
  return { config, queue, registry, spawn };
};

const enqueue = (
  runner: Runner,
  sessionId: string,
  prompt: string,
  workingDir: string,
  opts: EnqueueOptions = {},
): RunHandle => {
  const existing = runner.registry.get(sessionId);
  if (
    existing !== undefined &&
    (existing.status === "queued" || existing.status === "running")
  )
    throw new Error(`Session ${sessionId} already has an active or queued run`);

  const handle: InternalHandle = {
    sessionId,
    prompt,
    workingDir,
    status: "queued",
    queuePosition: runner.queue.size,
    lines: [],
    error: undefined,
    cancelled: false,
    process: undefined,
    onLine: opts.onLine,
    onStatus: opts.onStatus,
  };
  runner.registry.set(sessionId, handle);
  handle.onStatus?.(handle);

  const invocation = resumeInvocation(sessionId, prompt);

  void runner.queue.add(async () => {
    if (handle.cancelled) return;
    handle.status = "running";
    handle.queuePosition = undefined;
    handle.onStatus?.(handle);

    try {
      const proc = runner.spawn(runner.config.gooseBinary, invocation.args, {
        stdin: invocation.stdin,
        cwd: workingDir,
      });
      handle.process = proc;

      for await (const line of proc.stdout) {
        if (isStopped(handle)) break;
        handle.lines.push(line);
        handle.onLine?.(line);
      }
      const result = await proc.exit;
      if (!isStopped(handle)) {
        handle.status = result.exitCode === 0 ? "completed" : "error";
        if (result.exitCode !== 0) handle.error = describeFailure(result);
      }
    } catch (err) {
      if (!isStopped(handle)) {
        handle.status = "error";
        handle.error = err instanceof Error ? err.message : String(err);
      }
    }

    handle.process = undefined;
    handle.onStatus?.(handle);
  });

  return handle;
};

const stop = (runner: Runner, sessionId: string): boolean => {
  const handle = runner.registry.get(sessionId);
  if (handle === undefined) return false;

  if (handle.status === "queued") {
    handle.cancelled = true;
    handle.status = "stopped";
    handle.queuePosition = undefined;
    handle.onStatus?.(handle);
    return true;
  }

  if (handle.status === "running" && handle.process !== undefined) {
    handle.status = "stopped";
    handle.process.kill("SIGINT");
    return true;
  }

  return false;
};

const getStatus = (runner: Runner, sessionId: string): RunStatus | undefined =>
  runner.registry.get(sessionId)?.status;

const getHandle = (runner: Runner, sessionId: string): RunHandle | undefined =>
  runner.registry.get(sessionId);

export type {
  EnqueueOptions,
  GooseInvocation,
  ProcessResult,
  RunHandle,
  Runner,
  RunnerConfig,
  RunStatus,
  SpawnedProcess,
  SpawnFn,
};
export {
  createRunner,
  DEFAULT_RUNNER_CONFIG,
  defaultSpawn,
  enqueue,
  getHandle,
  getStatus,
  killProcessGroup,
  makeRunnerConfig,
  newSessionInvocation,
  resumeInvocation,
  stop,
};
