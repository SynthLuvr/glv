import PQueue from "p-queue";
import { defaultSpawn } from "./spawn.js";
import type {
  InternalHandle,
  RunHandle,
  Runner,
  RunnerConfig,
  RunStatus,
  SpawnFn,
} from "./types.js";

const createRunner = (
  config: RunnerConfig,
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

export { createRunner, getHandle, isTerminalStatus };
