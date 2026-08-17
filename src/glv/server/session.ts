import { isTerminalStatus, type RunHandle } from "../runner/index.js";

const activeRunPrompt = (run: RunHandle | undefined): string | undefined =>
  run !== undefined && !isTerminalStatus(run.status) ? run.prompt : undefined;

export { activeRunPrompt };
