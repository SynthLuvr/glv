import prettyMilliseconds from "pretty-ms";

type ToolRun = {
  /** Which tool the newest unanswered request row named. */
  name: string;
  /** Parallel calls sharing the request row. */
  count: number;
  /** When the request row was written (epoch ms). */
  startMs: number;
  /** Timeout its arguments asked for, in seconds; absent when none. */
  timeoutSec?: number;
};

// Status-hint text shared by server-side rendering and the client bundle
// (esbuild, platform "browser"): keep imports pure JavaScript so the
// bundle stays Node-free.

// Compact wall-clock durations — "45s", "12m", "1m 30s" — capped at two
// units and never rolled up into days.
const fmtDuration = (seconds: number): string =>
  prettyMilliseconds(Math.max(0, Math.round(seconds)) * 1000, {
    hideYearAndDays: true,
    unitCount: 2,
  });

// The status-hint sentence for an in-flight tool call:
// "⟳ bash running for 3m (timeout 30m)". The elapsed leg ticks
// client-side; the timeout leg is static.
const toolRunText = (tool: ToolRun, now: number = Date.now()): string => {
  const who = tool.count > 1 ? `${tool.name} (+${tool.count - 1})` : tool.name;
  const elapsed = fmtDuration((now - tool.startMs) / 1000);
  const timeout =
    tool.timeoutSec !== undefined && tool.timeoutSec > 0
      ? ` (timeout ${fmtDuration(tool.timeoutSec)})`
      : "";
  return `⟳ ${who} running for ${elapsed}${timeout}`;
};

const queuedSuffix = (count: number): string =>
  count > 0 ? ` (${count} prompt${count > 1 ? "s" : ""} queued next)` : "";

export type { ToolRun };
export { fmtDuration, queuedSuffix, toolRunText };
