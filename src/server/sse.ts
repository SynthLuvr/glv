import type { SSEStreamingApi } from "hono/streaming";
import type { SessionRow } from "../db.js";
import { fmtRelative } from "../format/index.js";
import type { LineBuffer, RunHandle } from "../runner/index.js";
import { renderStreamLine } from "../views/stream-line.js";

// Minimal structural shape emit()/flushPreview() touch, so tests can supply a
// fake stream without asserting the full SSEStreamingApi interface.
type SseWriter = {
  aborted: boolean;
  writeSSE: (input: {
    id?: string;
    event: string;
    data: string;
  }) => Promise<unknown>;
};

// Writing to a closed stream (client disconnect) throws; guard each emission.
// The optional `id` sets the SSE event id so EventSource can resume via
// Last-Event-ID on transient reconnect.
const emit = async (
  stream: SseWriter,
  event: string,
  data: string,
  id?: number,
): Promise<boolean> => {
  if (stream.aborted) return false;
  try {
    await stream.writeSSE({
      event,
      data,
      ...(id !== undefined ? { id: String(id) } : {}),
    });
    return true;
  } catch {
    return false;
  }
};

// drain snapshots before any await, so concurrent pushes can't mutate the
// emitted lines. Returns nextSeq on success, false on abort.
const flushPreview = async (
  stream: SseWriter,
  buffer: LineBuffer,
  fromSeq: number,
  id?: number,
): Promise<number | false> => {
  const { lines, nextSeq } = buffer.drain(fromSeq);
  for (const line of lines) {
    const html = renderStreamLine(line);
    if (html !== "" && !(await emit(stream, "preview", html, id))) return false;
  }
  return nextSeq;
};

const emitStatus = async (
  stream: SSEStreamingApi,
  handle: RunHandle,
  id?: number,
): Promise<boolean> =>
  emit(
    stream,
    "status",
    JSON.stringify({
      status: handle.status,
      queuePosition: handle.queuePosition,
      pendingCount: handle.pendingPrompts.length,
      startedCount: handle.startedPrompts.length,
      error: handle.error ?? null,
    }),
    id,
  );

const emitMeta = async (
  stream: SSEStreamingApi,
  session: SessionRow,
  id?: number,
): Promise<boolean> =>
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
