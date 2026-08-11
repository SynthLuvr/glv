import { type } from "arktype";
import type PQueue from "p-queue";
import { DEFAULT_SYSTEM_PROMPT } from "../system.js";
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
};

const DEFAULT_STOP_GRACE_MS = 5000;
const DEFAULT_MAX_LINES = 5000;
const DEFAULT_TERMINAL_RETENTION_MS = 30000;

const RunnerConfigSchema = type({
  maxConcurrent: "number.integer >= 1",
  gooseBinary: "string >= 1",
  stopGraceMs: "number.integer >= 1",
  maxLines: "number.integer >= 1",
  terminalRetentionMs: "number.integer >= 1",
});

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxConcurrent: 6,
  gooseBinary: "goose",
  stopGraceMs: DEFAULT_STOP_GRACE_MS,
  maxLines: DEFAULT_MAX_LINES,
  terminalRetentionMs: DEFAULT_TERMINAL_RETENTION_MS,
};

const makeRunnerConfig = (
  maxConcurrent: number,
  gooseBinary: string,
  stopGraceMs: number = DEFAULT_STOP_GRACE_MS,
  maxLines: number = DEFAULT_MAX_LINES,
  terminalRetentionMs: number = DEFAULT_TERMINAL_RETENTION_MS,
): RunnerConfig => {
  const result = RunnerConfigSchema({
    maxConcurrent,
    gooseBinary,
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

// DESIGN DECISION: --system MUST be passed on every invocation, including
// resume (`-r`) sessions — not just the first prompt of a new session.
//
// goose does NOT persist the --system flag across resume sessions. It is a
// per-invocation runtime injection: goose applies it fresh on each `goose run`
// but never writes it into the stored conversation history. This was verified
// empirically against goose 1.45.0:
//
//   1. New session + --system "pirate persona" → response in pirate-speak ✓
//   2. Resume WITHOUT --system                → normal English, persona lost ✗
//   3. Resume WITH --system                   → pirate persona restored ✓
//
// The system-prompt text was also confirmed absent from the persisted session
// database — only user/assistant/tool messages are stored, not the --system
// value. Removing --system from resumeInvocation would silently strip the
// guardrails from every follow-up, reverting the model to stock goose behaviour.
//
// The token cost is negligible: ~240 tokens (156 words) vs. the 10K–100K+
// tokens of a typical resumed conversation — well under 1% overhead.
//
// The only alternative that would avoid per-invocation passing is setting the
// prompt at the goose config level (~/.config/goose/config.yaml), but that
// affects ALL goose usage system-wide, not just GLV-managed sessions.
const SYSTEM_FLAGS = ["--system", DEFAULT_SYSTEM_PROMPT];

type GooseInvocation = {
  args: string[];
  stdin: string;
};

const resumeInvocation = (
  sessionId: string,
  prompt: string,
): GooseInvocation => ({
  args: [
    "run",
    "-r",
    ...SYSTEM_FLAGS,
    "--session-id",
    sessionId,
    ...STREAM_FLAGS,
  ],
  stdin: prompt,
});

const newSessionInvocation = (prompt: string): GooseInvocation => ({
  args: ["run", ...SYSTEM_FLAGS, ...STREAM_FLAGS],
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
  kill: (signal?: NodeJS.Signals) => void;
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
