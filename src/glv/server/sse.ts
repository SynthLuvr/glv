import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
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

// A raw-response SSE channel. Fastify hands us the Node response via
// reply.hijack(); this wraps the tiny surface the stream routes need:
// writeSSE (a silent no-op once the client is gone), sleep, aborted, and
// lastEventId for resume.
class SseStream {
  readonly lastEventId: string | undefined;
  #res: ServerResponse;
  #aborted = false;

  constructor(req: IncomingMessage, res: ServerResponse) {
    this.#res = res;
    const header = req.headers["last-event-id"];
    this.lastEventId = Array.isArray(header) ? header[0] : header;
    // The request 'close' event fires when the connection tears down —
    // client disconnect, socket error, or server shutdown destroying the
    // socket — exactly the abort signal the poll loops check.
    req.on("close", () => {
      this.#aborted = true;
    });
  }

  get aborted(): boolean {
    return this.#aborted;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  // Multi-line data fans out across `data:` lines per the SSE wire format.
  async writeSSE({
    event,
    data,
    id,
  }: {
    event?: string;
    data: string;
    id?: string;
  }): Promise<void> {
    if (this.#aborted || this.#res.writableEnded) return;
    let frame = "";
    if (event !== undefined) frame += `event: ${event}\n`;
    if (id !== undefined) frame += `id: ${id}\n`;
    for (const line of data.split("\n")) frame += `data: ${line}\n`;
    frame += "\n";
    await new Promise<void>((resolve, reject) => {
      this.#res.write(frame, "utf8", (err) => {
        if (err !== null && err !== undefined) reject(err);
        else resolve();
      });
    });
  }

  close(): void {
    if (!this.#res.writableEnded) this.#res.end();
  }
}

// Hijacks the reply and runs the handler against a raw SSE stream. The
// stream never closes on its own; the handler's return (poll budget
// exhausted, session deleted) or client disconnect ends it.
const streamSSE = (
  req: FastifyRequest,
  reply: FastifyReply,
  handler: (stream: SseStream) => Promise<void>,
): void => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const stream = new SseStream(req.raw, res);
  void handler(stream)
    .catch((err: unknown) => {
      console.error(err);
    })
    .finally(() => {
      stream.close();
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

export { emit, emitMeta, emitStatus, flushPreview, SseStream, streamSSE };
