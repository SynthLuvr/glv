import { type } from "arktype";
import type PQueue from "p-queue";

type RunnerConfig = {
  maxConcurrent: number;
  gooseBinary: string;
  /** How long a finished run's handle is retained before eviction (ms). */
  retentionMs: number;
};

const RunnerConfigSchema = type({
  maxConcurrent: "number.integer >= 1",
  gooseBinary: "string >= 1",
  retentionMs: "number.integer >= 0",
});

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxConcurrent: 6,
  gooseBinary: "goose",
  retentionMs: 60_000,
};

const makeRunnerConfig = (
  maxConcurrent: number,
  gooseBinary: string,
  retentionMs: number = DEFAULT_RUNNER_CONFIG.retentionMs,
): RunnerConfig => {
  const result = RunnerConfigSchema({
    maxConcurrent,
    gooseBinary,
    retentionMs,
  });
  if (result instanceof type.errors)
    throw new Error(`Invalid runner configuration: ${result.summary}`);
  return result;
};

// Cap on captured output lines held per run. A verbose session can emit far
// more than this; the oldest lines are trimmed once the cap is reached (the
// full record lives in goose's session database), bounding per-run memory.
const MAX_LINE_BUFFER = 2000;

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
  /**
   * Captured NDJSON output, newest last. A sliding window: once it exceeds
   * MAX_LINE_BUFFER the oldest entries are dropped and lineOffset advances.
   */
  lines: string[];
  /** Absolute index of lines[0] (how many oldest lines have been trimmed). */
  lineOffset: number;
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
  /** Live SSE streams currently reading this handle (defers eviction). */
  streamCount: number;
  /** Pending retention-timer handle; cleared on eviction or reschedule. */
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
  DEFAULT_RUNNER_CONFIG,
  MAX_LINE_BUFFER,
  makeRunnerConfig,
  newSessionInvocation,
  resumeInvocation,
};
