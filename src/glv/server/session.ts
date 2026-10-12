import { isTerminalStatus, type RunHandle } from "../runner/index.js";
import { readStopNotice } from "../stop-notices.js";
import type { ServerContext } from "./context.js";

const activeRunPrompt = (run: RunHandle | undefined): string | undefined =>
  run !== undefined && !isTerminalStatus(run.status) ? run.prompt : undefined;

// The persisted stop-early notice for a session's last run, when the
// provider refused service. The prompt bar shows the live run's own error
// while its handle exists and falls back to this once it is gone.
const stopNoticeFor = (
  ctx: ServerContext,
  sessionId: string,
): string | undefined =>
  ctx.stopNotices === undefined
    ? undefined
    : readStopNotice(ctx.stopNotices, sessionId);

export { activeRunPrompt, stopNoticeFor };
