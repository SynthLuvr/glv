import type { FastifyReply } from "fastify";
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

// SSE framing is @fastify/sse's job (registered in server/index.tsx, which
// also pulls in the reply.sse type augmentation; routes opt in with the
// `sse: "only"` option): the plugin serializes frames, honors backpressure,
// and closes the response when the handler resolves. What this facade adds
// back is the lifecycle contract this project relied on — the reconnect
// cursor, and writes after a client disconnect resolving as cheap no-ops,
// so emission sites need no abort guarding.
type SseMessage = {
  event: SessionEventName | FeedEventName;
  data: string;
  id?: string;
};

type SseStream = {
  /**
   * The `Last-Event-ID` header an EventSource sends on reconnect;
   * undefined on a first connect.
   */
  readonly lastEventId: string | undefined;
  readonly aborted: boolean;
  sleep: (ms: number) => Promise<unknown>;
  writeSSE: (message: SseMessage) => Promise<void>;
};

// The plugin rejects a send that loses the race between its own connection
// gate and the socket closing; both of its close errors — the typed
// FST_ERR_SSE_CONNECTION_CLOSED and the plain Error off the write path —
// mean the client is gone, which this facade reports as a no-op write.
const isDisconnect = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  if (err.message === "SSE connection is closed") return true;
  return (
    "code" in err &&
    typeof err.code === "string" &&
    err.code === "FST_ERR_SSE_CONNECTION_CLOSED"
  );
};

// Runs a stream body over reply.sse. The poll loop owns the connection's
// lifetime: @fastify/sse closes the response when this promise settles, so
// the handler returns it rather than hijacking the reply. Errors surface on
// stderr instead of killing the process — the handler must resolve, never
// throw, once frames are on the wire.
const streamSse = (
  reply: FastifyReply,
  run: (stream: SseStream) => Promise<void>,
): Promise<void> => {
  const sse = reply.sse;
  const stream: SseStream = {
    lastEventId: sse.lastEventId ?? undefined,
    get aborted() {
      return !sse.isConnected;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    writeSSE: async (message) => {
      if (!sse.isConnected) return;
      try {
        await sse.send(message);
      } catch (err) {
        if (!isDisconnect(err)) throw err;
      }
    },
  };

  return run(stream).catch((err: unknown) => {
    console.error("sse stream failed:", err);
  });
};

// The optional `id` sets the SSE event id so EventSource can resume via
// Last-Event-ID on transient reconnect. writeSSE is a no-op after the client
// disconnects, so emissions need no abort guarding.
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
