import { type } from "arktype";
import type PQueue from "p-queue";
import { DEFAULT_SYSTEM_PROMPT } from "../system.js";
import type { LineBuffer } from "./ring-buffer.js";

type RunnerConfig = {
  maxConcurrent: number;
  gooseBinary: string;
  /** Extra system instructions passed to goose via `--system` ("" = none). */
  system: string;
  /** Grace window (ms) after each stop signal before escalating it. */
  stopGraceMs: number;
  /** Max NDJSON lines retained per run before the oldest are dropped. */
  maxLines: number;
  /** How long (ms) a terminal run lingers before eviction from the registry. */
  terminalRetentionMs: number;
};

const DEFAULT_STOP_GRACE_MS = 5000;
const DEFAULT_MAX_LINES = 5000;
const DEFAULT_TERMINAL_RETENTION_MS = 30000;

const RunnerConfigSchema = type({
  maxConcurrent: "number.integer >= 1",
  gooseBinary: "string >= 1",
  system: "string",
  stopGraceMs: "number.integer >= 1",
  maxLines: "number.integer >= 1",
  terminalRetentionMs: "number.integer >= 1",
});

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxConcurrent: 6,
  gooseBinary: "goose",
  system: DEFAULT_SYSTEM_PROMPT,
  stopGraceMs: DEFAULT_STOP_GRACE_MS,
  maxLines: DEFAULT_MAX_LINES,
  terminalRetentionMs: DEFAULT_TERMINAL_RETENTION_MS,
};

const makeRunnerConfig = (
  maxConcurrent: number,
  gooseBinary: string,
  system: string = DEFAULT_SYSTEM_PROMPT,
  stopGraceMs: number = DEFAULT_STOP_GRACE_MS,
  maxLines: number = DEFAULT_MAX_LINES,
  terminalRetentionMs: number = DEFAULT_TERMINAL_RETENTION_MS,
): RunnerConfig => {
  const result = RunnerConfigSchema({
    maxConcurrent,
    gooseBinary,
    system,
    stopGraceMs,
    maxLines,
    terminalRetentionMs,
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

// `--system <text>` is passed as a real argv element (execa hands args to the
// binary as an array, so there are no shell-quoting concerns) only when the
// text is non-empty, so an explicit `--system ""` disables the guardrails.
// goose still reads the user prompt from stdin via `-i -`; the system text
// stays a normal flag value.
const systemFlags = (system: string): string[] =>
  system === "" ? [] : ["--system", system];

const resumeInvocation = (
  sessionId: string,
  prompt: string,
  system: string = DEFAULT_SYSTEM_PROMPT,
): GooseInvocation => ({
  args: [
    "run",
    "-r",
    ...systemFlags(system),
    "--session-id",
    sessionId,
    ...STREAM_FLAGS,
  ],
  stdin: prompt,
});

const newSessionInvocation = (
  prompt: string,
  system: string = DEFAULT_SYSTEM_PROMPT,
): GooseInvocation => ({
  args: ["run", ...systemFlags(system), ...STREAM_FLAGS],
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
  DEFAULT_RUNNER_CONFIG,
  makeRunnerConfig,
  newSessionInvocation,
  resumeInvocation,
};
