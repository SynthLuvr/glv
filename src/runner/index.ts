import PQueue from "p-queue";
import {
  clearPending,
  enqueue,
  enqueueNew,
  enqueueOrQueue,
  generateTempKey,
  rekey,
  stop,
  stopAll,
} from "./queue.js";
import { defaultSpawn, killProcessGroup } from "./spawn.js";
import type {
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
} from "./types.js";
import {
  DEFAULT_RUNNER_CONFIG,
  makeRunnerConfig,
  newSessionInvocation,
  resumeInvocation,
} from "./types.js";

const createRunner = (
  config: RunnerConfig = DEFAULT_RUNNER_CONFIG,
  spawn: SpawnFn = defaultSpawn,
): Runner => {
  const queue = new PQueue({ concurrency: config.maxConcurrent });
  const registry = new Map<string, InternalHandle>();
  return { config, queue, registry, spawn };
};

const isTerminalStatus = (status: RunStatus): boolean =>
  status === "completed" || status === "stopped" || status === "error";

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
  isTerminalStatus,
  killProcessGroup,
  makeRunnerConfig,
  newSessionInvocation,
  rekey,
  resumeInvocation,
  stop,
  stopAll,
};
