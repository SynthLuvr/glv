import { type } from "arktype";
import type PQueue from "p-queue";
import { DEFAULT_SYSTEM_PROMPT } from "../system.js";
import type { LineBuffer } from "./ring-buffer.js";

type RunnerConfig = {
  maxConcurrent: number;
  claudeBinary: string;
  /**
   * "inherit" (the default) passes no --permission-mode flag, deferring
   * to ~/.claude/settings.json; any other value is passed and overrides it.
   */
  permissionMode: string;
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

// DESIGN DECISION: the default is "inherit", which passes no
// --permission-mode flag, so claude applies permissions.defaultMode from
// ~/.claude/settings.json and glv-launched runs behave like terminal
// sessions. Any other mode is passed as the flag and silently OVERRIDES
// that setting (verified against claude 2.1.232); headless --print runs
// cannot show permission prompts, so under "manual" a tool call needing
// approval is denied outright. bypassPermissions grants full agency; see
// the security note in the README before pinning it. ("plan" is excluded:
// in --print mode it returns a plan instead of acting.)
const DEFAULT_PERMISSION_MODE = "inherit";
const PERMISSION_MODES: readonly string[] = [
  "inherit",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "manual",
];

const RunnerConfigSchema = type({
  maxConcurrent: "number.integer >= 1",
  claudeBinary: "string >= 1",
  permissionMode: "string >= 1",
  stopGraceMs: "number.integer >= 1",
  maxLines: "number.integer >= 1",
  terminalRetentionMs: "number.integer >= 1",
});

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxConcurrent: 6,
  claudeBinary: "claude",
  permissionMode: DEFAULT_PERMISSION_MODE,
  stopGraceMs: DEFAULT_STOP_GRACE_MS,
  maxLines: DEFAULT_MAX_LINES,
  terminalRetentionMs: DEFAULT_TERMINAL_RETENTION_MS,
};

const makeRunnerConfig = (
  maxConcurrent: number,
  claudeBinary: string,
  permissionMode: string = DEFAULT_PERMISSION_MODE,
  stopGraceMs: number = DEFAULT_STOP_GRACE_MS,
  maxLines: number = DEFAULT_MAX_LINES,
  terminalRetentionMs: number = DEFAULT_TERMINAL_RETENTION_MS,
): RunnerConfig => {
  const result = RunnerConfigSchema({
    maxConcurrent,
    claudeBinary,
    permissionMode,
    stopGraceMs,
    maxLines,
    terminalRetentionMs,
  });
  if (result instanceof type.errors)
    throw new Error(`Invalid runner configuration: ${result.summary}`);
  if (!PERMISSION_MODES.includes(permissionMode))
    throw new Error(
      `Invalid permission mode "${permissionMode}": must be one of ${PERMISSION_MODES.join(", ")}`,
    );
  return result;
};

// claude reads the prompt from stdin when `--print` is given no positional
// prompt — this sidesteps the OS argument-length limit and all shell-quoting
// concerns, and works for arbitrarily long prompts. `--verbose` is required
// for stream-json to emit the full event stream rather than just the final
// result record.
const STREAM_FLAGS = ["--print", "--output-format", "stream-json", "--verbose"];

// DESIGN DECISION: --append-system-prompt is passed on every invocation,
// including resume (--resume) sessions — not just the first prompt of a
// new session. It is a per-invocation runtime injection that claude does
// NOT persist into the stored conversation. This was verified empirically
// against claude 2.1.232:
//
//   1. New session + --append-system-prompt "reply BANANA only" → "BANANA" ✓
//   2. Resume WITHOUT the flag                          → "6" (persona lost) ✗
//   3. Resume WITH the flag                             → "BANANA" ✓
//
// The token cost is negligible: ~240 tokens (156 words) vs. the
// 10K–100K+ tokens of a typical resumed conversation — well under 1%
// overhead.
//
// --append-system-prompt is used rather than --system-prompt because the
// latter REPLACES claude's built-in system prompt, stripping out the tool
// instructions the coding agent depends on.
//
// The only alternative that would avoid per-invocation passing is setting
// the prompt at the claude config level (~/.claude/settings.json), but
// that affects ALL claude usage system-wide, not just GLV-managed
// sessions.
const SYSTEM_FLAGS = ["--append-system-prompt", DEFAULT_SYSTEM_PROMPT];

const permissionFlags = (mode: string): string[] =>
  mode === "inherit" ? [] : ["--permission-mode", mode];

type ClaudeInvocation = {
  args: string[];
  stdin: string;
};

// glv pre-assigns the session id (verified: claude 2.1.232 honours
// --session-id and names the transcript <uuid>.jsonl accordingly), so the
// id is known before the process even starts — no discovery poll, no
// chance of attributing an unrelated transcript to the new session.
const newSessionInvocation = (
  prompt: string,
  sessionId: string,
  permissionMode: string = DEFAULT_PERMISSION_MODE,
): ClaudeInvocation => ({
  args: [
    "--session-id",
    sessionId,
    ...SYSTEM_FLAGS,
    ...permissionFlags(permissionMode),
    ...STREAM_FLAGS,
  ],
  stdin: prompt,
});

const resumeInvocation = (
  sessionId: string,
  prompt: string,
  permissionMode: string = DEFAULT_PERMISSION_MODE,
): ClaudeInvocation => ({
  args: [
    "--resume",
    sessionId,
    ...SYSTEM_FLAGS,
    ...permissionFlags(permissionMode),
    ...STREAM_FLAGS,
  ],
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

type InternalHandle = Omit<
  RunHandle,
  "prompt" | "pendingPrompts" | "startedPrompts"
> & {
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
  PERMISSION_MODES,
  resumeInvocation,
};
