import { type Context } from "hono";
import {
  type SSEMessage,
  type SSEStreamingApi,
  streamSSE,
} from "hono/streaming";
import { fmtRelative, type ToolRun } from "../format/index.js";
import type { StreamEnvelope } from "../profile.js";
import type { LineBuffer, RunHandle } from "../runner/index.js";
import type { SessionRow } from "../sessions.js";
import {
  type FeedEventName,
  type SessionEventName,
  sessionEventData,
  type ToolEventPayload,
} from "../sse-events.js";
import { renderStreamLine } from "../views/stream-line.js";

// The registry hono build lacks the SSE lifecycle fixes this project used to
// consume from a fork (honojs/hono#5289): exposing the reconnect cursor and
// making writes after a client disconnect cheap no-ops. streamSse vendors
// both, so the routes keep fork semantics on the stock package.
type SseStream = {
  /** The `Last-Event-ID` header an EventSource sends on reconnect;
   * undefined on a first connect.
   */
  readonly lastEventId: string | undefined;
  readonly aborted: boolean;
  sleep: (ms: number) => Promise<unknown>;
  writeSSE: (message: SSEMessage) => Promise<void>;
};

const wrapSse = (
  api: SSEStreamingApi,
  lastEventId: string | undefined,
): SseStream => ({
  lastEventId,
  get aborted() {
    return api.aborted;
  },
  sleep: (ms) => api.sleep(ms),
  writeSSE: async (message) => {
    // After the client disconnects the writable is torn down; depending on
    // the runtime, writing to it throws or hangs. Checking aborted first
    // keeps emissions no-ops, exactly as the fork did.
    if (api.aborted) return;
    await api.writeSSE(message);
  },
});

// streamSSE with the vendored lifecycle fixes applied (see SseStream).
const streamSse = (
  c: Context,
  run: (stream: SseStream) => Promise<void>,
): Response => {
  const lastEventId = c.req.header("Last-Event-ID");
  return streamSSE(c, async (api) => {
    await run(wrapSse(api, lastEventId));
  });
};

// The optional `id` sets the SSE event id so EventSource can resume via
// Last-Event-ID on transient reconnect. writeSSE is a no-op after the client
// disconnects (wrapSse), so emissions need no abort guarding.
const emit = (
  stream: SseStream,
  event: SessionEventName | FeedEventName,
  data: string,
  id?: number,
): Promise<void> => stream.writeSSE({ event, data, id: id?.toString() });

// drain snapshots before any await, so concurrent pushes can't mutate the
// emitted lines. Returns the next sequence number to resume from.
const flushPreview = async (
  stream: SseStream,
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

// pendingTool writes an explicit `timeoutSec: undefined` when no timeout
// applies; a spread would copy it into the nested tool object, where
// jsonSafe cannot strip it and the contract rejects it.
const toolEvent = (tool: ToolRun): ToolEventPayload =>
  tool.timeoutSec === undefined
    ? { name: tool.name, count: tool.count, startMs: tool.startMs }
    : { ...tool };

// Status payloads carry the run's bookkeeping plus, while a run is running,
// the tool call it is currently waiting on (from the persisted request row)
// — null when the newest row is not an unanswered request.
const emitStatus = (
  stream: SseStream,
  handle: RunHandle,
  tool: ToolRun | undefined,
  id?: number,
): Promise<void> =>
  emit(
    stream,
    "status",
    sessionEventData("status", {
      status: handle.status,
      queuePosition: handle.queuePosition,
      pendingCount: handle.pendingPrompts.length,
      startedCount: handle.startedPrompts.length,
      error: handle.error ?? null,
      tool:
        handle.status === "running" && tool !== undefined
          ? toolEvent(tool)
          : null,
    }),
    id,
  );

const emitMeta = (
  stream: SseStream,
  session: SessionRow,
  id?: number,
): Promise<void> =>
  emit(
    stream,
    "meta",
    sessionEventData("meta", {
      updated: fmtRelative(session.updated_at),
      updatedTitle: session.updated_at,
    }),
    id,
  );

export type { SseStream };
export { emit, emitMeta, emitStatus, flushPreview, streamSse };
