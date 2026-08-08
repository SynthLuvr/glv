import type { SessionRow } from "../db.js";
import { fmtRelative } from "../format/index.js";
import type { LineBuffer, RunHandle } from "../runner/index.js";
import { renderStreamLine } from "../views/stream-line.js";
import type { LooseContext } from "./http.js";

// Server-Sent Events writer shared by the per-session and status feeds.
// Mirrors the surface Hono's streamSSE exposed (writeSSE/aborted/sleep) so the
// polling loops and emit helpers stay unchanged, now backed by a web-standard
// ReadableStream served directly by Elysia.
type SseStream = {
  aborted: boolean;
  writeSSE: (input: {
    event: string;
    data: string;
    id?: string;
  }) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
};

// Minimal structural shape emit()/flushPreview() touch, so the helpers can run
// against any SseStream without naming the full field set.
type SseWriter = {
  aborted: boolean;
  writeSSE: (input: {
    event: string;
    data: string;
    id?: string;
  }) => Promise<unknown>;
};

const sseHeaders = (): Record<string, string> => ({
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
});

// Builds a streaming text/event-stream Response and runs `run` against a
// writer. Aborts (writer.aborted) on client disconnect via both the request
// signal and the ReadableStream cancel hook, so long-lived poll loops exit.
const streamSSE = (
  c: LooseContext,
  run: (stream: SseStream) => Promise<void>,
): Response => {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream: SseStream = {
    aborted: false,
    writeSSE: async ({ event, data, id }) => {
      if (stream.aborted) return false;
      let chunk = `event: ${event}\ndata: ${data}\n`;
      if (id !== undefined) chunk += `id: ${id}\n`;
      chunk += "\n";
      controller?.enqueue(encoder.encode(chunk));
      return true;
    },
    sleep: (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  };

  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      controller = ctl;
    },
    cancel() {
      stream.aborted = true;
    },
  });

  // Request signal aborts when the underlying socket closes.
  c.request.signal?.addEventListener("abort", () => {
    stream.aborted = true;
  });

  // Drain the producer; close the stream once it finishes so the client sees
  // end-of-stream rather than an idle hang.
  void run(stream)
    .catch(() => undefined)
    .finally(() => {
      stream.aborted = true;
      try {
        controller?.close();
      } catch {
        // Already closed by the client disconnecting.
      }
    });

  return new Response(body, {
    headers: sseHeaders(),
    status: typeof c.set.status === "number" ? c.set.status : undefined,
  });
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
  stream: SseStream,
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
  stream: SseStream,
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

export type { SseStream };
export { emit, emitMeta, emitStatus, flushPreview, streamSSE };
