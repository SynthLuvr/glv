import type { SSEStreamingApi } from "hono/streaming";
import type { SessionRow } from "../db.js";
import { fmtRelative, type ParsedMessage } from "../format/index.js";
import type { LineBuffer, RunHandle } from "../runner/index.js";
import { renderMessage } from "../views/message-blocks.js";
import { renderStreamLine } from "../views/stream-line.js";

// Minimal structural shape emit()/flushLines() touch, so tests can supply a
// fake stream without asserting the full SSEStreamingApi interface.
type SseWriter = {
  aborted: boolean;
  writeSSE: (input: { event: string; data: string }) => Promise<unknown>;
};

// Writing to a closed stream (client disconnect) throws; guard each emission.
const emit = async (
  stream: SseWriter,
  event: string,
  data: string,
): Promise<boolean> => {
  if (stream.aborted) return false;
  try {
    await stream.writeSSE({ event, data });
    return true;
  } catch {
    return false;
  }
};

// Snapshots the buffer synchronously via `drain(fromSeq)`, then emits each
// line. The snapshot is a fresh copy taken before any `await` yield point, so
// a concurrent `push` (which overwrites slots via modular arithmetic) can
// never mutate the returned array mid-iteration. Returns `nextSeq` (the
// snapshot boundary) on success, or `false` on abort.
const flushLines = async (
  stream: SseWriter,
  buffer: LineBuffer,
  fromSeq: number,
): Promise<number | false> => {
  const { lines, nextSeq } = buffer.drain(fromSeq);
  for (const line of lines) {
    const html = renderStreamLine(line);
    if (html !== "" && !(await emit(stream, "line", html))) return false;
  }
  return nextSeq;
};

const flushMessages = async (
  stream: SSEStreamingApi,
  messages: ParsedMessage[],
  from: number,
): Promise<boolean> => {
  for (let i = from; i < messages.length; i++) {
    const html = renderMessage(messages[i], i);
    if (html !== "" && !(await emit(stream, "append", html))) return false;
  }
  return true;
};

// Lets the client distinguish replayed (pre-connect) prompt events from
// genuine queued→running transitions, so only the latter dismiss a card.
const emitStatus = async (
  stream: SSEStreamingApi,
  handle: RunHandle,
): Promise<boolean> =>
  emit(
    stream,
    "status",
    JSON.stringify({
      status: handle.status,
      queuePosition: handle.queuePosition,
      pendingCount: handle.pendingPrompts.length,
      startedCount: handle.startedPrompts.length,
    }),
  );

const emitMeta = async (
  stream: SSEStreamingApi,
  session: SessionRow,
): Promise<boolean> =>
  emit(
    stream,
    "meta",
    JSON.stringify({
      updated: fmtRelative(session.updated_at),
      updatedTitle: session.updated_at,
    }),
  );

export { emit, emitMeta, emitStatus, flushLines, flushMessages };
