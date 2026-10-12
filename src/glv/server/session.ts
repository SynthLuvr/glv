import { isTerminalStatus, type RunHandle } from "../runner/index.js";
import { readStopNotice } from "../stop-notices.js";
import type { ServerContext } from "./context.js";

const activeRunPrompt = (run: RunHandle | undefined): string | undefined =>
  run !== undefined && !isTerminalStatus(run.status) ? run.prompt : undefined;

// The stop-early notice a session view should show: the live run's own
// message while its handle still exists (terminal errors carry it), else
// the persisted one from the sidecar. Undefined when the last run ended
// normally or no run ever happened.
const stopNoticeFor = (
  ctx: ServerContext,
  sessionId: string,
): string | undefined => {
  if (ctx.stopNotices === undefined) return undefined;
  return readStopNotice(ctx.stopNotices, sessionId)?.message;
};

export { activeRunPrompt, stopNoticeFor };
