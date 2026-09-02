import { type } from "arktype";
import type PQueue from "p-queue";
import type { ModelSelection } from "../models.js";
import type { LineBuffer } from "./ring-buffer.js";

// Mid-run steering contract for flavors whose agent binary accepts user
// messages as NDJSON lines on a long-lived stdin (claude's --input-format
// stream-json). Flavors without a streaming-input mode leave `steer`
// undefined and every follow-up queues.
type SteerSpec = {
  /** Encode one prompt as a single NDJSON line for stdin. */
  readonly encode: (prompt: string) => string;
  /** True when an output line marks the end of one prompt's turn. */
  readonly isTurnEnd: (line: string) => boolean;
};

// How the shared runner talks to one flavor's agent binary. argv is built
// per invocation; the prompt itself always travels over stdin, so
// arbitrarily long prompts never hit argument-length limits or shell
// quoting.
type AgentInvocation = {
  /** Agent name in exit/error messages ("goose", "claude"). */
  readonly name: string;
  /** Resolved binary to launch. */
  readonly binary: string;
  /**
   * argv for a brand-new run. `key` is the runner handle id: flavors that
   * can pre-assign the session id forward it to the agent; flavors that
   * discover the id afterwards ignore it.
   */
  readonly newSession: (
    prompt: string,
    key: string,
    model?: ModelSelection,
  ) => string[];
  /** argv for a follow-up run on an existing session. */
  readonly resume: (key: string, prompt: string) => string[];
  /** Extra environment variables for the agent process. */
  readonly env: () => Record<string, string>;
  /** Streaming-input dialect, or undefined when the flavor cannot steer. */
  readonly steer: SteerSpec | undefined;
};

type RunnerConfig = {
  maxConcurrent: number;
  agent: AgentInvocation;
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
  stopGraceMs: "number.integer >= 1",
  maxLines: "number.integer >= 1",
  terminalRetentionMs: "number.integer >= 1",
});

const makeRunnerConfig = (
  maxConcurrent: number,
  agent: AgentInvocation,
  stopGraceMs: number = DEFAULT_STOP_GRACE_MS,
  maxLines: number = DEFAULT_MAX_LINES,
  terminalRetentionMs: number = DEFAULT_TERMINAL_RETENTION_MS,
): RunnerConfig => {
  if (agent.binary.trim() === "")
    throw new Error("Invalid runner configuration: agent binary is empty");
  const result = RunnerConfigSchema({
    maxConcurrent,
    stopGraceMs,
    maxLines,
    terminalRetentionMs,
  });
  if (result instanceof type.errors)
    throw new Error(`Invalid runner configuration: ${result.summary}`);
  return { maxConcurrent, agent, stopGraceMs, maxLines, terminalRetentionMs };
};

type RunStatus = "queued" | "running" | "completed" | "stopped" | "error";

type RunHandle = {
  readonly sessionId: string;
  readonly prompt: string;
  status: RunStatus;
  /** Approximate position in the queue (undefined when running or done). */
  queuePosition: number | undefined;
  output: LineBuffer;
  error: string | undefined;
  /** Prompts not yet delivered to any process, oldest first. */
  readonly pendingPrompts: readonly PendingPrompt[];
  /** Every prompt that has begun executing, oldest first (for stream replay). */
  readonly startedPrompts: readonly string[];
  /** True when this flavor can inject prompts into the live process. */
  readonly steerable: boolean;
  /** Follow-ups injected into the live process so far. */
  readonly steeredCount: number;
};

// A prompt held back while its run is busy. `mode` decides delivery:
// "steer" goes to the live process's stdin (at spawn time when the submit
// raced the spawn, or chained like "queue" once that stdin has closed);
// "queue" chains as a fresh resume invocation once the process exits.
type PendingPrompt = {
  readonly prompt: string;
  readonly mode: "steer" | "queue";
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
  /** Writes one NDJSON line (newline appended) to stdin; throws when it's gone. */
  write: (line: string) => void;
  /** Ends stdin so a streaming-input agent finishes its queue and exits. */
  closeStdin: () => void;
};

/** Subprocess factory; tests inject a fake to avoid spawning a real agent. */
type SpawnFn = (
  binary: string,
  args: string[],
  opts: {
    stdin: string;
    cwd: string;
    env: Record<string, string>;
    /** Keep stdin open for mid-run writes instead of piping `stdin` and closing. */
    keepStdinOpen?: boolean;
  },
) => SpawnedProcess;

type Invocation = {
  args: string[];
  stdin: string;
};

type InternalHandle = Omit<
  RunHandle,
  "sessionId" | "prompt" | "pendingPrompts" | "startedPrompts"
> & {
  // Writable: rekeyed from a temp key to the agent's real session id.
  sessionId: string;
  // Writable: updated as chained prompts advance.
  prompt: string;
  pendingPrompts: PendingPrompt[];
  startedPrompts: string[];
  steeredCount: number;
  readonly workingDir: string;
  cancelled: boolean;
  process: SpawnedProcess | undefined;
  // Per-process steering bookkeeping, reset at each spawn: prompts written
  // to this process's stdin, and whether that stdin closed after the last
  // expected turn result.
  turnsStarted: number;
  stdinClosed: boolean;
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
  AgentInvocation,
  InternalHandle,
  Invocation,
  LineBuffer,
  PendingPrompt,
  ProcessResult,
  RunHandle,
  Runner,
  RunnerConfig,
  RunStatus,
  SpawnedProcess,
  SpawnFn,
  SteerSpec,
};
export { makeRunnerConfig };
