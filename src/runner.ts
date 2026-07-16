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

// goose assigns its own session name, so no `-n` flag is passed — `goose
// run` decides the name itself.
const newSessionInvocation = (prompt: string): GooseInvocation => ({
  args: ["run", ...STREAM_FLAGS],
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

type RunStatus = "queued" | "running" | "completed" | "stopped" | "error";

type RunHandle = {
  readonly sessionId: string;
  readonly prompt: string;
  status: RunStatus;
  /** Approximate position in the queue (undefined when running or done). */
  queuePosition: number | undefined;
  lines: string[];
  error: string | undefined;
};

type ProcessResult = {
  exitCode: number | null;
  signal?: string;
};

type SpawnedProcess = {
  pid: number;
  kill: (signal?: string) => void;
  stdout: AsyncIterable<string>;
  exit: Promise<ProcessResult>;
};

/** Subprocess factory; tests inject a fake to avoid spawning real goose. */
type SpawnFn = (
  binary: string,
  args: string[],
  opts: { stdin: string; cwd: string },
) => SpawnedProcess;

type EnqueueOptions = {
  onLine?: (line: string) => void;
  onStatus?: (handle: RunHandle) => void;
};

type InternalHandle = Omit<RunHandle, "sessionId"> & {
  // Writable: rekeyed from the temp id to goose's real session id.
  sessionId: string;
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

// Kill the whole process group so grandchildren (tool shells, stdio
// extensions) are reaped too. Runs spawn detached, so the goose PID doubles as
// the group leader ID.
const killProcessGroup = (pid: number, signal: string = "SIGINT"): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already exited.
  }
};

const describeFailure = (result: ProcessResult): string => {
  if (result.signal !== undefined)
    return `goose killed by signal ${result.signal}`;
  if (result.exitCode === null) return "goose process exited unexpectedly";
  return `goose exited with code ${result.exitCode}`;
};

const failRun = (handle: InternalHandle, err: unknown): void => {
  if (handle.status === "stopped") return;
  handle.status = "error";
  handle.error = err instanceof Error ? err.message : String(err);
};

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
      const err = e as { exitCode?: number; signal?: string };
      return { exitCode: err.exitCode ?? null, signal: err.signal };
    },
  );

  const kill = (signal: string = "SIGINT"): void => {
    killProcessGroup(pid, signal);
  };

  return { pid, kill, stdout, exit };
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
    handle.onLine?.(line);
  }

  const result = await proc.exit;
  if (handle.status === "stopped") return;
  handle.status = result.exitCode === 0 ? "completed" : "error";
  if (result.exitCode !== 0) handle.error = describeFailure(result);
};

const createRunner = (
  config: RunnerConfig = DEFAULT_RUNNER_CONFIG,
  spawn: SpawnFn = defaultSpawn,
): Runner => {
  const queue = new PQueue({ concurrency: config.maxConcurrent });
  const registry = new Map<string, InternalHandle>();
  return { config, queue, registry, spawn };
};

const enqueueInvocation = (
  runner: Runner,
  key: string,
  invocation: GooseInvocation,
  workingDir: string,
  opts: EnqueueOptions = {},
): RunHandle => {
  const existing = runner.registry.get(key);
  if (
    existing !== undefined &&
    (existing.status === "queued" || existing.status === "running")
  )
    throw new Error(`Session ${key} already has an active or queued run`);

  const handle: InternalHandle = {
    sessionId: key,
    prompt: invocation.stdin,
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
  runner.registry.set(key, handle);
  handle.onStatus?.(handle);

  void runner.queue.add(async () => {
    if (handle.cancelled) return;
    handle.status = "running";
    handle.queuePosition = undefined;
    handle.onStatus?.(handle);

    try {
      await runProcess(runner, handle, invocation);
    } catch (err) {
      failRun(handle, err);
    }

    handle.process = undefined;
    handle.onStatus?.(handle);
  });

  return handle;
};

const enqueue = (
  runner: Runner,
  sessionId: string,
  prompt: string,
  workingDir: string,
  opts: EnqueueOptions = {},
): RunHandle =>
  enqueueInvocation(
    runner,
    sessionId,
    resumeInvocation(sessionId, prompt),
    workingDir,
    opts,
  );

// goose assigns its own session id, so the run starts under a temporary
// key and is re-keyed once the DB poll finds the real id (see rekey).
const enqueueNew = (
  runner: Runner,
  tempKey: string,
  prompt: string,
  workingDir: string,
  opts: EnqueueOptions = {},
): RunHandle =>
  enqueueInvocation(
    runner,
    tempKey,
    newSessionInvocation(prompt),
    workingDir,
    opts,
  );

const rekey = (runner: Runner, oldKey: string, newKey: string): boolean => {
  const handle = runner.registry.get(oldKey);
  if (handle === undefined) return false;
  runner.registry.delete(oldKey);
  handle.sessionId = newKey;
  runner.registry.set(newKey, handle);
  return true;
};

// Prefixed so it can never collide with a real goose session id.
const generateTempKey = (): string =>
  `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

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

// Reaps all live goose processes on server shutdown.
const stopAll = (runner: Runner): number => {
  let stopped = 0;
  for (const sessionId of runner.registry.keys())
    if (stop(runner, sessionId)) stopped++;
  return stopped;
};

const isTerminalStatus = (status: RunStatus): boolean =>
  status === "completed" || status === "stopped" || status === "error";

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
  enqueueNew,
  generateTempKey,
  getHandle,
  getStatus,
  isTerminalStatus,
  killProcessGroup,
  makeRunnerConfig,
  newSessionInvocation,
  rekey,
  resumeInvocation,
  stop,
  stopAll,
};
