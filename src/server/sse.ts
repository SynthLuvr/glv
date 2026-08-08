import { sse } from "elysia";
import type { SessionRow } from "../db.js";
import { fmtRelative } from "../format/index.js";
import type { LineBuffer, RunHandle } from "../runner/index.js";
import { renderStreamLine } from "../views/stream-line.js";

// A single Server-Sent Events frame. Elysia's built-in sse() helper flags the
// payload and attaches the serializer its stream handler invokes, so Elysia
// owns the text/event-stream headers, framing, and client-disconnect teardown.
// Route handlers only build frames and yield them from an async generator.
const frame = (event: string, data: string, id?: number) =>
  sse({
    event,
    data,
    ...(id !== undefined ? { id: String(id) } : {}),
  });

type Frame = ReturnType<typeof frame>;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Emits buffered runner output as preview frames and returns the next sequence
// number so the caller tracks its offset across polls. drain snapshots before
// any await, so concurrent pushes can't mutate the emitted lines.
const flushPreview = async function* (
  buffer: LineBuffer,
  fromSeq: number,
  id?: number,
): AsyncGenerator<Frame, number> {
  const { lines, nextSeq } = buffer.drain(fromSeq);
  for (const line of lines) {
    const html = renderStreamLine(line);
    if (html !== "") yield frame("preview", html, id);
  }
  return nextSeq;
};

const statusFrame = (handle: RunHandle, id?: number): Frame =>
  frame(
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

const metaFrame = (session: SessionRow, id?: number): Frame =>
  frame(
    "meta",
    JSON.stringify({
      updated: fmtRelative(session.updated_at),
      updatedTitle: session.updated_at,
    }),
    id,
  );

export type { Frame };
export { flushPreview, frame, metaFrame, sleep, statusFrame };
