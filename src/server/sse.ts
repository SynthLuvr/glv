import type { SSEStreamingApi } from "hono/streaming";
import type { SessionRow } from "../db.js";
import { fmtRelative } from "../format/index.js";
import type { RunHandle } from "../runner/index.js";
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

// `from` and `dropped` are absolute line-sequence offsets. The ring buffer
// drops oldest lines as `dropped` grows, so a live stream's monotonic `from`
// must be rebased past the dropped prefix before indexing into `lines`.
// Preview lines are transient — cleared when the DB catches up — so dropped
// lines are simply skipped, never fatal.
const flushPreview = async (
  stream: SseWriter,
  lines: string[],
  dropped: number,
  from: number,
  id?: number,
): Promise<boolean> => {
  for (let i = Math.max(from - dropped, 0); i < lines.length; i++) {
    const html = renderStreamLine(lines[i]);
    if (html !== "" && !(await emit(stream, "preview", html, id))) return false;
  }
  return true;
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
