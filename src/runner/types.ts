import { type } from "arktype";
import type PQueue from "p-queue";
import { DEFAULT_SYSTEM_PROMPT } from "../system.js";
import type { LineBuffer } from "./ring-buffer.js";

type RunnerConfig = {
  maxConcurrent: number;
  claudeBinary: string;
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
  claudeBinary: "string >= 1",
  stopGraceMs: "number.integer >= 1",
  maxLines: "number.integer >= 1",
  terminalRetentionMs: "number.integer >= 1",
});

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxConcurrent: 6,
  claudeBinary: "claude",
  stopGraceMs: DEFAULT_STOP_GRACE_MS,
  maxLines: DEFAULT_MAX_LINES,
  terminalRetentionMs: DEFAULT_TERMINAL_RETENTION_MS,
};

const makeRunnerConfig = (
  maxConcurrent: number,
  claudeBinary: string,
  stopGraceMs: number = DEFAULT_STOP_GRACE_MS,
  maxLines: number = DEFAULT_MAX_LINES,
  terminalRetentionMs: number = DEFAULT_TERMINAL_RETENTION_MS,
): RunnerConfig => {
  const result = RunnerConfigSchema({
    maxConcurrent,
    claudeBinary,
    stopGraceMs,
    maxLines,
    terminalRetentionMs,
  });
  if (result instanceof type.errors)
    throw new Error(`Invalid runner configuration: ${result.summary}`);
  return result;
};

// claude reads the prompt from stdin when `--print` is given no positional
// prompt — this sidesteps the OS argument-length limit and all shell-quoting
// concerns, and works for arbitrarily long prompts. `--verbose` is required
// for stream-json to emit the full event stream rather than just the final
// result record.
const STREAM_FLAGS = ["--print", "--output-format", "stream-json", "--verbose"];

// DESIGN DECISION: --append-system-prompt is passed on every invocation,
// including resume (`--resume`) sessions — not just the first prompt of a
// new session. Like goose's --system, it is a per-invocation runtime
// injection: always sending it guarantees the guardrails hold for every
// follow-up regardless of whether claude persists the text into the stored
// conversation. The token cost is negligible: ~240 tokens (156 words) vs.
// the 10K–100K+ tokens of a typical resumed conversation — well under 1%
// overhead.
//
// --append-system-prompt is used rather than --system-prompt because the
// latter REPLACES claude's built-in system prompt, stripping out the tool
// instructions and guardrails the coding agent depends on.
//
// The only alternative that would avoid per-invocation passing is setting
// the prompt at the claude config level (~/.claude/settings.json), but that
// affects ALL claude usage system-wide, not just GLV-managed sessions.
const SYSTEM_FLAGS = ["--append-system-prompt", DEFAULT_SYSTEM_PROMPT];

type ClaudeInvocation = {
  args: string[];
  stdin: string;
};

const resumeInvocation = (
  sessionId: string,
  prompt: string,
): ClaudeInvocation => ({
  args: [
    "--print",
    "--resume",
    sessionId,
    ...SYSTEM_FLAGS,
    "--output-format",
    "stream-json",
    "--verbose",
  ],
  stdin: prompt,
});

const newSessionInvocation = (prompt: string): ClaudeInvocation => ({
  args: ["--print", ...SYSTEM_FLAGS, ...STREAM_FLAGS],
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

/** Subprocess factory; tests inject a fake to avoid spawning real claude. */
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
  // Writable: rekeyed from the temp id to claude's real session id.
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
  ClaudeInvocation,
  EnqueueOptions,
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
