import PQueue from "p-queue";
import {
  clearPending,
  enqueue,
  enqueueNew,
  enqueueOrQueue,
  generateTempKey,
  isTerminalStatus,
  registerStream,
  rekey,
  releaseStream,
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
  MAX_LINE_BUFFER,
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
  MAX_LINE_BUFFER,
  makeRunnerConfig,
  newSessionInvocation,
  registerStream,
  rekey,
  releaseStream,
  resumeInvocation,
  stop,
  stopAll,
};
