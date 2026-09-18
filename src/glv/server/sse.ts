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
import { headerValue } from "./http.js";

// Fastify has no first-class SSE helper, so the response is hijacked and
// the wire format written by hand. The lifecycle contract this project
// relied on (the reconnect cursor, and writes after a client disconnect
// becoming cheap no-ops — the semantics the dropped hono fork carried) is
// preserved: lastEventId exposes the Last-Event-ID header, and writeSSE
// checks the abort flag before every write.
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

// The exact frame serialization hono's streamSSE used: event, then
// multi-line-safe data, then id — separated by newlines, terminated by a
// blank line.
const serialize = (message: SseMessage): string =>
  [
    `event: ${message.event}`,
    ...message.data.split("\n").map((line) => `data: ${line}`),
    ...(message.id !== undefined && message.id !== ""
      ? [`id: ${message.id}`]
      : []),
  ].join("\n") + "\n\n";

const streamSse = (
  reply: FastifyReply,
  run: (stream: SseStream) => Promise<void>,
): FastifyReply => {
  reply.hijack();
  const raw = reply.raw;
  const request = reply.request;
  let aborted = false;
  // The incoming request emits close when the client disconnects; after
  // the loop ends normally it fires again harmlessly.
  request.raw.on("close", () => {
    aborted = true;
  });

  // Honors backpressure: resolves on drain when the kernel buffer is full.
  const write = (chunk: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (raw.writableEnded || raw.destroyed) {
        aborted = true;
        resolve();
        return;
      }
      const flushed = raw.write(chunk, (err) => {
        if (err !== null && err !== undefined) reject(err);
      });
      if (flushed) resolve();
      else raw.once("drain", () => resolve());
    });

  const stream: SseStream = {
    get lastEventId() {
      return headerValue(request.headers["last-event-id"]);
    },
    get aborted() {
      return aborted;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    writeSSE: async (message) => {
      if (aborted || raw.writableEnded) return;
      await write(serialize(message));
    },
  };

  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // The response ends when the run completes (tests bound the poll count)
  // or fails; errors surface on stderr instead of killing the process.
  void run(stream)
    .catch((err: unknown) => {
      console.error("sse stream failed:", err);
    })
    .finally(() => {
      aborted = true;
      if (!raw.writableEnded) raw.end();
    });
  return reply;
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
