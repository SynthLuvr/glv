import type { SSEStreamingApi } from "hono/streaming";
import type { SessionRow } from "../db.js";
import { fmtRelative, type ParsedMessage } from "../format/index.js";
import type { RunHandle } from "../runner/index.js";
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

// `from` and `dropped` are absolute line-sequence offsets. The ring buffer
// drops oldest lines as `dropped` grows, so a live stream's monotonic `from`
// must be rebased past the dropped prefix before indexing into `lines`.
const flushLines = async (
  stream: SseWriter,
  lines: string[],
  dropped: number,
  from: number,
): Promise<boolean> => {
  for (let i = Math.max(from - dropped, 0); i < lines.length; i++) {
    const html = renderStreamLine(lines[i]);
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

// `startedCount` lets the client distinguish prompt events replayed on
// (re)connect (already-started prompts) from genuine queued→running
// transitions, so only the latter dismiss a queued-prompt card.
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
