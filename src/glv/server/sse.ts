import type { SSEStreamingApi } from "hono/streaming";
import { fmtRelative, type ToolRun } from "../format/index.js";
import type { StreamEnvelope } from "../profile.js";
import type { LineBuffer, RunHandle } from "../runner/index.js";
import type { SessionRow } from "../sessions.js";
import { renderStreamLine } from "../views/stream-line.js";

// The optional `id` sets the SSE event id so EventSource can resume via
// Last-Event-ID on transient reconnect. writeSSE is a no-op after the client
// disconnects, so emissions need no abort guarding.
const emit = (
  stream: SSEStreamingApi,
  event: string,
  data: string,
  id?: number,
): Promise<void> => stream.writeSSE({ event, data, id: id?.toString() });

// drain snapshots before any await, so concurrent pushes can't mutate the
// emitted lines. Returns the next sequence number to resume from.
const flushPreview = async (
  stream: SSEStreamingApi,
  buffer: LineBuffer,
  fromSeq: number,
  envelope: StreamEnvelope,
  id?: number,
): Promise<number> => {
  const { lines, nextSeq } = buffer.drain(fromSeq);
  for (const line of lines) {
    const html = renderStreamLine(line, envelope);
    if (html !== "") await emit(stream, "preview", html, id);
  }
  return nextSeq;
};

// Status payloads carry the run's bookkeeping plus, while a run is running,
// the tool call it is currently waiting on (from the persisted request row)
// — null when the newest row is not an unanswered request.
const emitStatus = (
  stream: SSEStreamingApi,
  handle: RunHandle,
  tool: ToolRun | undefined,
  id?: number,
): Promise<void> =>
  emit(
    stream,
    "status",
    JSON.stringify({
      status: handle.status,
      queuePosition: handle.queuePosition,
      pendingCount: handle.pendingPrompts.length,
      startedCount: handle.startedPrompts.length,
      error: handle.error ?? null,
      tool:
        handle.status === "running" && tool !== undefined
          ? { ...tool, timeoutSec: tool.timeoutSec ?? null }
          : null,
    }),
    id,
  );

const emitMeta = (
  stream: SSEStreamingApi,
  session: SessionRow,
  id?: number,
): Promise<void> =>
  emit(
    stream,
    "meta",
    JSON.stringify({
      updated: fmtRelative(session.updated_at),
      updatedTitle: session.updated_at,
    }),
    id,
  );

export { emit, emitMeta, emitStatus, flushPreview };
