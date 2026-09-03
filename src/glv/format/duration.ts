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
// (esbuild, platform "browser"). Pure and import-free on purpose: nothing
// here may touch Node built-ins.

// Compact wall-clock durations: 45s, 12m, 3h 05m, 2h.
const fmtDuration = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${hours}h`
    : `${hours}h ${String(rest).padStart(2, "0")}m`;
};

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
