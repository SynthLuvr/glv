import { type } from "arktype";
import PQueue from "p-queue";

type RunnerConfig = {
  maxConcurrent: number;
  gooseBinary: string;
};

const RunnerConfigSchema = type({
  maxConcurrent: "number.integer >= 1",
  gooseBinary: "string >= 1",
});

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxConcurrent: 6,
  gooseBinary: "goose",
};

// goose reads instructions from stdin via `-i -` (the `-` is the stdin marker),
// never as a `-t` argument — this sidesteps the OS argument-length limit and all
// shell-quoting concerns, and works for arbitrarily long prompts.
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

const newSessionInvocation = (
  name: string,
  prompt: string,
): GooseInvocation => ({
  args: ["run", ...STREAM_FLAGS, "-n", name],
  stdin: prompt,
});

const makeRunnerConfig = (
  maxConcurrent: number,
  gooseBinary: string,
): RunnerConfig => {
  const result = RunnerConfigSchema({ maxConcurrent, gooseBinary });
  if (result instanceof type.errors)
    throw new Error(`Invalid runner configuration: ${result.summary}`);
  return result;
};

type Runner = {
  config: RunnerConfig;
  queue: PQueue;
};

const createRunner = (config: RunnerConfig = DEFAULT_RUNNER_CONFIG): Runner => {
  const queue = new PQueue({ concurrency: config.maxConcurrent });
  return { config, queue };
};

export type { GooseInvocation, Runner, RunnerConfig };
export {
  createRunner,
  DEFAULT_RUNNER_CONFIG,
  makeRunnerConfig,
  newSessionInvocation,
  resumeInvocation,
};
