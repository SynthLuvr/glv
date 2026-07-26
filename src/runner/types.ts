import { type } from "arktype";
import type PQueue from "p-queue";
import type { LineBuffer } from "./ring-buffer.js";

type RunnerConfig = {
  maxConcurrent: number;
  gooseBinary: string;
  /** Grace window (ms) after each stop signal before escalating it. */
  stopGraceMs: number;
  /** Max NDJSON lines retained per run before the oldest are dropped. */
  maxLines: number;
  /** How long (ms) a terminal run lingers before eviction from the registry. */
  terminalRetentionMs: number;
  /** Deadline (ms) for goose to emit its first output line before a restart. */
  startupTimeoutMs: number;
  /** Max restart attempts when goose hangs before its first output line. */
  maxStartupRetries: number;
};

const DEFAULT_STOP_GRACE_MS = 5000;
const DEFAULT_MAX_LINES = 5000;
const DEFAULT_TERMINAL_RETENTION_MS = 30000;
// goose loads MCP servers and providers at startup, which can take several
// seconds — 30 s is long enough to avoid false restarts yet still recovers a
// genuinely wedged process instead of parking a runner slot forever.
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_MAX_STARTUP_RETRIES = 2;

const RunnerConfigSchema = type({
  maxConcurrent: "number.integer >= 1",
  gooseBinary: "string >= 1",
  stopGraceMs: "number.integer >= 1",
  maxLines: "number.integer >= 1",
  terminalRetentionMs: "number.integer >= 1",
  startupTimeoutMs: "number.integer >= 1",
  maxStartupRetries: "number.integer >= 0",
});

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxConcurrent: 6,
  gooseBinary: "goose",
  stopGraceMs: DEFAULT_STOP_GRACE_MS,
  maxLines: DEFAULT_MAX_LINES,
  terminalRetentionMs: DEFAULT_TERMINAL_RETENTION_MS,
  startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  maxStartupRetries: DEFAULT_MAX_STARTUP_RETRIES,
};

const makeRunnerConfig = (
  maxConcurrent: number,
  gooseBinary: string,
  stopGraceMs: number = DEFAULT_STOP_GRACE_MS,
  maxLines: number = DEFAULT_MAX_LINES,
  terminalRetentionMs: number = DEFAULT_TERMINAL_RETENTION_MS,
  startupTimeoutMs: number = DEFAULT_STARTUP_TIMEOUT_MS,
  maxStartupRetries: number = DEFAULT_MAX_STARTUP_RETRIES,
): RunnerConfig => {
  const result = RunnerConfigSchema({
    maxConcurrent,
    gooseBinary,
    stopGraceMs,
    maxLines,
    terminalRetentionMs,
    startupTimeoutMs,
    maxStartupRetries,
  });
  if (result instanceof type.errors)
    throw new Error(`Invalid runner configuration: ${result.summary}`);
  return result;
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

type RunStatus = "queued" | "running" | "completed" | "stopped" | "error";

type RunHandle = {
  readonly sessionId: string;
  readonly prompt: string;
  status: RunStatus;
  /** Approximate position in the queue (undefined when running or done). */
  queuePosition: number | undefined;
  output: LineBuffer;
  error: string | undefined;
  /** FIFO queue of prompts not yet started (for chained-run display). */
  readonly pendingPrompts: readonly string[];
  /** Every prompt that has begun executing, oldest first (for stream replay). */
  readonly startedPrompts: readonly string[];
};

type ProcessResult = {
  exitCode: number | null;
  signal?: string;
  /** stderr captured by the spawn layer on failure (execa's buffered copy). */
  stderr?: string;
  /** Short message describing a spawn failure (e.g. "spawn goose ENOENT"). */
  message?: string;
  /** True when goose could not be spawned at all (binary missing / refused). */
  spawnFailed?: boolean;
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
  isNewSession?: boolean;
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
  // Retention timer that eventually deletes a terminal handle from the registry.
  evictionTimer: ReturnType<typeof setTimeout> | undefined;
};

type Runner = {
  readonly config: RunnerConfig;
  readonly queue: PQueue;
  readonly registry: Map<string, InternalHandle>;
  readonly spawn: SpawnFn;
};

export type {
  EnqueueOptions,
  GooseInvocation,
  InternalHandle,
  ProcessResult,
  RunHandle,
  Runner,
  RunnerConfig,
  RunStatus,
  SpawnedProcess,
  SpawnFn,
};
export {
  DEFAULT_MAX_STARTUP_RETRIES,
  DEFAULT_RUNNER_CONFIG,
  DEFAULT_STARTUP_TIMEOUT_MS,
  makeRunnerConfig,
  newSessionInvocation,
  resumeInvocation,
};
