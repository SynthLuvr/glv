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
  /** FIFO queue of prompts not yet started (for chained-run display). */
  readonly pendingPrompts: readonly string[];
  /** Every prompt that has begun executing, oldest first (for stream replay). */
  readonly startedPrompts: readonly string[];
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

type InternalHandle = Omit<
  RunHandle,
  "sessionId" | "prompt" | "pendingPrompts" | "startedPrompts"
> & {
  // Writable: rekeyed from the temp id to goose's real session id.
  sessionId: string;
  // Writable: updated as chained prompts advance.
  prompt: string;
  pendingPrompts: string[];
  startedPrompts: string[];
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

// Map preserves insertion order, so registry order mirrors queue order.
const refreshQueuePositions = (runner: Runner): void => {
  let position = 0;
  for (const handle of runner.registry.values()) {
    if (handle.status !== "queued") continue;
    if (handle.queuePosition !== position) {
      handle.queuePosition = position;
      handle.onStatus?.(handle);
    }
    position++;
  }
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
    pendingPrompts: [],
    startedPrompts: [],
    workingDir,
    status: "queued",
    queuePosition: undefined,
    lines: [],
    error: undefined,
    cancelled: false,
    process: undefined,
    onLine: opts.onLine,
    onStatus: opts.onStatus,
  };
  runner.registry.set(key, handle);
  refreshQueuePositions(runner);

  void runner.queue.add(async () => {
    let currentInvocation = invocation;

    // Chaining loop: after each run completes, if the session wasn't stopped
    // and prompts remain in the queue, advance to the next automatically.
    // The handle stays non-terminal for the entire chain — only goes
    // terminal when no prompts remain — so the stream's loop stays alive
    // and lines accumulate continuously.
    while (true) {
      if (handle.cancelled) return;
      handle.status = "running";
      handle.queuePosition = undefined;
      handle.onStatus?.(handle);
      refreshQueuePositions(runner);

      try {
        await runProcess(runner, handle, currentInvocation);
      } catch (err) {
        failRun(handle, err);
      }

      handle.process = undefined;

      // Stop = kill everything, including pending prompts.
      // The `as` widens the narrowing that TS applied at the
      // `handle.status = "running"` assignment above; runProcess can and
      // does change the status (completed / error / stopped).
      if ((handle.status as RunStatus) === "stopped") {
        handle.pendingPrompts = [];
        break;
      }

      // Error does NOT block the chain — proceed to next pending prompt.
      const nextPrompt = handle.pendingPrompts.shift();
      if (nextPrompt === undefined) break;

      // Advance to the next run.  All of this is synchronous (no await)
      // so the stream never observes a transient terminal status.
      handle.startedPrompts.push(nextPrompt);
      handle.prompt = nextPrompt;
      handle.error = undefined;
      handle.status = "running";
      currentInvocation = resumeInvocation(handle.sessionId, nextPrompt);
      handle.onStatus?.(handle);
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

const enqueueOrQueue = (
  runner: Runner,
  sessionId: string,
  prompt: string,
  workingDir: string,
  opts: EnqueueOptions = {},
): { handle: RunHandle; queued: boolean } => {
  const existing = runner.registry.get(sessionId);
  if (
    existing !== undefined &&
    (existing.status === "queued" || existing.status === "running")
  ) {
    existing.pendingPrompts.push(prompt);
    existing.onStatus?.(existing);
    return { handle: existing, queued: true };
  }
  return {
    handle: enqueue(runner, sessionId, prompt, workingDir, opts),
    queued: false,
  };
};

const clearPending = (runner: Runner, sessionId: string): number => {
  const handle = runner.registry.get(sessionId);
  if (handle === undefined) return 0;
  const count = handle.pendingPrompts.length;
  if (count === 0) return 0;
  handle.pendingPrompts = [];
  handle.onStatus?.(handle);
  return count;
};

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
    handle.pendingPrompts = [];
    handle.queuePosition = undefined;
    handle.onStatus?.(handle);
    refreshQueuePositions(runner);
    return true;
  }

  if (handle.status === "running" && handle.process !== undefined) {
    handle.status = "stopped";
    handle.pendingPrompts = [];
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
  clearPending,
  createRunner,
  DEFAULT_RUNNER_CONFIG,
  defaultSpawn,
  enqueue,
  enqueueNew,
  enqueueOrQueue,
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
