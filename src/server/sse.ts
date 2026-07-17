import type { SSEStreamingApi } from "hono/streaming";
import type { SessionRow } from "../db.js";
import { fmtRelative, type ParsedMessage } from "../format/index.js";
import type { RunHandle } from "../runner/index.js";
import { renderMessage } from "../views/message-blocks.js";
import { renderStreamLine } from "../views/stream-line.js";

// Writing to a closed stream (client disconnect) throws; guard each emission.
const emit = async (
  stream: SSEStreamingApi,
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

// Emit every retained line at or after the absolute `from` cursor. The buffer
// is a sliding window (lineOffset = absolute index of lines[0]); clamping
// `from` keeps a stream aligned even after the oldest lines are trimmed.
const flushLines = async (
  stream: SSEStreamingApi,
  handle: RunHandle,
  from: number = 0,
): Promise<boolean> => {
  const start = Math.max(0, from - handle.lineOffset);
  for (let i = start; i < handle.lines.length; i++) {
    const html = renderStreamLine(handle.lines[i]);
    if (html !== "" && !(await emit(stream, "line", html))) return false;
  }
  return true;
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
