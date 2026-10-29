import { type } from "arktype";
import type PQueue from "p-queue";
import type { ModelSelection } from "../models.js";
import { nonEmptyEnv, positiveEnvNumber } from "../util.js";
import type { LineBuffer } from "./ring-buffer.js";
import {
  MEMORY_SPEC_ERROR,
  type MemoryCeiling,
  parseMemoryCeiling,
} from "./scope.js";

// How the prompt travels over stdin, and what happens to the pipe
// afterwards. "one-shot" (the default) writes the prompt and closes
// stdin — the text-prompt model, where the agent answers the single
// prompt it was fed and exits. "held" writes and keeps the pipe open:
// for an agent whose headless mode reads streaming input (claude with
// `--input-format stream-json`), an open stdin is what makes the
// session "live" — pending background tasks survive the end of a turn,
// their completion wakes the agent as a new turn, and the process
// exits only once the policy below closes the pipe (ADR 0010).
type StdinPlan =
  | { readonly kind: "one-shot"; readonly input: string }
  | {
      readonly kind: "held";
      readonly input: string;
      readonly policy: StdinClosePolicy;
    };

// Watches the agent's own output stream and decides when a held-open
// stdin may close — that is, when the process is allowed to exit.
// Called once per invocation with the runner's (idempotent) close
// handle; `onLine` sees every ingested stdout line, oldest first;
// `stop` fires exactly once at process exit or teardown so pending
// timers can be cancelled.
type StdinClosePolicy = (close: () => void) => {
  onLine: (line: string) => void;
  stop: () => void;
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
  /**
   * The agent's stdin plan for a prompt; absent means one-shot text.
   * claude supplies the held-open stream-json plan so background work
   * can outlive a turn (ADR 0010).
   */
  readonly stdinPlan?: (prompt: string) => StdinPlan;
};

// The agent is not part of the config: one runner serves several agents
// (one concurrency pool across all of them), so the invocation travels
// with each enqueue instead.
type RunnerConfig = {
  maxConcurrent: number;
  /** Grace window (ms) after each stop signal before escalating it. */
  stopGraceMs: number;
  /** Max NDJSON lines retained per run before the oldest are dropped. */
  maxLines: number;
  /** How long (ms) a terminal run lingers before eviction from the registry. */
  terminalRetentionMs: number;
  /**
   * Startup deadline (ms): a run that has emitted no stdout line when it
   * passes is failed with a diagnostic and its process tree killed, so a
   * silently stalled agent cannot park a handle in "running" forever and
   * starve the concurrency pool.
   */
  startupTimeoutMs: number;
  /**
   * The server-wide per-run memory ceiling (#392): each invocation runs
   * in its own transient systemd scope with MemoryMax set to this
   * budget, so one ballooning run cannot OOM-kill the whole service.
   * `{ kind: "off" }` restores the shared-cgroup behavior (with a
   * logged warning); individual runs may override it (RunHandle's
   * memoryMax).
   */
  memoryMax: MemoryCeiling;
};

const DEFAULT_STOP_GRACE_MS = 5000;
const DEFAULT_MAX_LINES = 5000;
const DEFAULT_TERMINAL_RETENTION_MS = 30000;
// Generous by design: a legitimate first line can be slow (cold npx
// installs of MCP extensions, model catalogue warm-up), but no healthy
// startup is silent for five minutes. GLV_STARTUP_TIMEOUT_MS overrides it
// (the same test-facing pattern as GLV_CRON_SESSION_TIMEOUT_MS).
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;

// The default per-run ceiling (#392): generous enough that healthy
// agent runs never graze it, tight enough that a runaway one dies alone
// in its own scope. GLV_RUN_MEMORY_MAX and --run-memory-max override it.
const DEFAULT_RUN_MEMORY_MAX_SPEC = "8G";

const RunnerConfigSchema = type({
  maxConcurrent: "number.integer >= 1",
  stopGraceMs: "number.integer >= 1",
  maxLines: "number.integer >= 1",
  terminalRetentionMs: "number.integer >= 1",
  startupTimeoutMs: "number.integer >= 1",
});

const makeRunnerConfig = (
  maxConcurrent: number,
  memoryMaxSpec?: string,
): RunnerConfig => {
  const config = {
    maxConcurrent,
    stopGraceMs: DEFAULT_STOP_GRACE_MS,
    maxLines: DEFAULT_MAX_LINES,
    terminalRetentionMs: DEFAULT_TERMINAL_RETENTION_MS,
    startupTimeoutMs: positiveEnvNumber(
      "GLV_STARTUP_TIMEOUT_MS",
      DEFAULT_STARTUP_TIMEOUT_MS,
    ),
  };
  const result = RunnerConfigSchema(config);
  if (result instanceof type.errors)
    throw new Error(`Invalid runner configuration: ${result.summary}`);
  const spec =
    memoryMaxSpec ??
    nonEmptyEnv("GLV_RUN_MEMORY_MAX", DEFAULT_RUN_MEMORY_MAX_SPEC);
  const memoryMax = parseMemoryCeiling(spec);
  if (memoryMax === undefined)
    throw new Error(
      `Invalid runner configuration: memory limit "${spec}" — ` +
        MEMORY_SPEC_ERROR,
    );
  return { ...config, memoryMax };
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
  /**
   * Provider-refusal notice (usage limit, network outage, ...) detected
   * on the run's stream — unlike `error`, set only for refusals the
   * agent announced itself, the ones worth persisting beyond the
   * handle's lifetime.
   */
  stopNotice: string | undefined;
  /**
   * Set when the run was stopped by the server (today only the shutdown
   * teardown) rather than the user, so the last-run verdict can say why;
   * undefined for a user stop, which records no reason (#379).
   */
  stopReason: string | undefined;
  /**
   * Identity of the current invocation, stamped fresh per process
   * spawn — so a chained prompt starts a new one. One settle can
   * notify twice (the stop request and the exit); both carry the same
   * id, so the run-history recorder counts the run once (#384).
   * Undefined until the first invocation starts.
   */
  runId: string | undefined;
  /** When the current invocation started (epoch ms); undefined while queued. */
  startedAt: number | undefined;
  /**
   * The systemd scope the current invocation runs in (`glv-run-<run id>`;
   * undefined when it spawned directly). Stamped fresh per invocation
   * and recorded in run history so a journal entry about a breached
   * scope attributes back to the run (#392).
   */
  scopeUnit: string | undefined;
  /**
   * This run's own ceiling override (#392): undefined means the
   * server-wide config decides. A follow-up submit may set it; the
   * override applies from the session's next invocation.
   */
  memoryMax: MemoryCeiling | undefined;
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
  /** Newline-split stderr, drained into a bounded diagnostic tail. */
  stderr: AsyncIterable<string>;
  exit: Promise<ProcessResult>;
  /**
   * Ends the agent's stdin, idempotently and safely at any point in the
   * process's life. For a one-shot spawn this is a no-op (the prompt
   * write already ended the pipe); for a held-open one it is the "you
   * may exit now" signal.
   */
  closeStdin: () => void;
};

/** Subprocess factory; tests inject a fake to avoid spawning a real agent. */
type SpawnFn = (
  binary: string,
  args: string[],
  opts: { stdin: StdinPlan; cwd: string; env: Record<string, string> },
) => SpawnedProcess;

// The plan an agent with no opinion gets: the prompt as one-shot text.
const planStdin = (agent: AgentInvocation, prompt: string): StdinPlan =>
  agent.stdinPlan?.(prompt) ?? { kind: "one-shot", input: prompt };

type Invocation = {
  args: string[];
  stdin: StdinPlan;
};

type InternalHandle = Omit<
  RunHandle,
  "sessionId" | "prompt" | "pendingPrompts" | "startedPrompts"
> & {
  // Writable: rekeyed from a temp key to the agent's real session id.
  sessionId: string;
  // Writable: updated as chained prompts advance.
  prompt: string;
  pendingPrompts: string[];
  startedPrompts: string[];
  readonly workingDir: string;
  // The agent this run belongs to: one pool serves several, so argv
  // building and spawning read it per handle.
  readonly agent: AgentInvocation;
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
  /** Run-settlement hook; see RunEndObserver. */
  readonly onRunEnd: RunEndObserver | undefined;
};

// Notified each time a run settles — every process exit, once more
// per chained prompt, and at the instant a stop request flips a live
// handle terminal (a stopped run's exit re-notifies with the same
// verdict, so the observer is never kept waiting past the process's
// death). The server uses it to persist stop notices and last-run
// verdicts beyond the handle's short terminal retention; the runner
// stays storage-free.
type RunEndObserver = (handle: RunHandle) => void;

export type {
  AgentInvocation,
  InternalHandle,
  Invocation,
  LineBuffer,
  MemoryCeiling,
  ProcessResult,
  RunEndObserver,
  RunHandle,
  Runner,
  RunnerConfig,
  RunStatus,
  SpawnedProcess,
  SpawnFn,
  StdinClosePolicy,
  StdinPlan,
};
export { makeRunnerConfig, planStdin };
