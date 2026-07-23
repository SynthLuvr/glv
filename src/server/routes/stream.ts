import { type Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { getSession, listMessages } from "../../db.js";
import { type ParsedMessage, parseMessage } from "../../format/index.js";
import { getHandle, isTerminalStatus } from "../../runner/index.js";
import { renderMessage } from "../../views/message-blocks.js";
import { renderPromptCard } from "../../views/transcript.js";
import type { ServerContext } from "../context.js";
import { emit, emitMeta, emitStatus, flushPreview } from "../sse.js";

type MessageDelta = { index: number; html: string };

// Mutable state threaded across poll iterations: snapshots detect in-place
// message edits; the rest track deltas so only changes are emitted.
type PollState = {
  snapshots: string[];
  msgCursor: number;
  lastName: string;
  lastUpdated: string;
  previewCleared: boolean;
  lastStatus: string | undefined;
  lastQueuePosition: number | undefined;
  lastPendingCount: number | undefined;
  lastStartedCount: number;
  sentLineOffset: number;
  flushedTerminal: boolean;
};

// Resume cursor: Last-Event-ID (auto-sent by EventSource on reconnect) takes
// precedence over the ?cursor= query from the initial connect.
const resumeCursor = (headerId: string, query?: string): number => {
  if (/^\d+$/.test(headerId)) return Number(headerId);
  if (query !== undefined && /^\d+$/.test(query)) return Number(query);
  return 0;
};

const renderCatchup = (
  messages: ParsedMessage[],
  cursor: number,
): MessageDelta[] => {
  const deltas: MessageDelta[] = [];
  for (let i = cursor; i < messages.length; i++) {
    const html = renderMessage(messages[i], i);
    if (html !== "") deltas.push({ index: i, html });
  }
  return deltas;
};

// Emits DB deltas — new messages, in-place edits, renames, and the meta chip.
// Returns false once the stream should stop (client gone or session deleted);
// the deleted case signals the client to close its EventSource.
const pollDb = async (
  stream: SSEStreamingApi,
  ctx: ServerContext,
  id: string,
  state: PollState,
): Promise<boolean> => {
  const session = getSession(ctx.db, id);
  if (session === undefined) {
    await emit(
      stream,
      "status",
      JSON.stringify({ status: "deleted" }),
      state.msgCursor,
    );
    return false;
  }

  const rows = listMessages(ctx.db, id);
  const messages = rows.map(parseMessage);
  let metaChanged = false;
  state.previewCleared = false;

  // New rows supersede the transient preview: append, then clear it.
  if (rows.length > state.snapshots.length) {
    for (let i = state.snapshots.length; i < messages.length; i++) {
      const html = renderMessage(messages[i], i);
      if (
        html !== "" &&
        !(await emit(
          stream,
          "append",
          JSON.stringify({ index: i, html }),
          i + 1,
        ))
      )
        return false;
    }
    state.msgCursor = rows.length;
    state.previewCleared = true;
    if (!(await emit(stream, "preview-clear", "", state.msgCursor)))
      return false;
  }

  // In-place content edits.
  const common = Math.min(state.snapshots.length, rows.length);
  for (let i = 0; i < common; i++) {
    if (rows[i].content_json === state.snapshots[i]) continue;
    const html = renderMessage(messages[i], i);
    if (
      html !== "" &&
      !(await emit(
        stream,
        "replace",
        JSON.stringify({ index: i, html }),
        state.msgCursor,
      ))
    )
      return false;
    metaChanged = true;
  }
  state.snapshots = rows.map((row) => row.content_json);

  // Goose derives a real title mid-run; follow the rename.
  if (session.name !== state.lastName) {
    state.lastName = session.name;
    if (
      !(await emit(
        stream,
        "rename",
        JSON.stringify({ name: session.name }),
        state.msgCursor,
      ))
    )
      return false;
  }

  if (session.updated_at !== state.lastUpdated) {
    state.lastUpdated = session.updated_at;
    metaChanged = true;
  }
  if (metaChanged && !(await emitMeta(stream, session, state.msgCursor)))
    return false;

  return true;
};

// Emits runner deltas — status/queue shifts, chained prompt cards, and NDJSON
// preview lines. Returns false once the stream should stop.
const pollRunner = async (
  stream: SSEStreamingApi,
  ctx: ServerContext,
  id: string,
  state: PollState,
): Promise<boolean> => {
  const h = getHandle(ctx.runner, id);
  if (h === undefined) return true;

  // A DB catch-up just cleared the preview; rebase so only new lines emit.
  if (state.previewCleared)
    state.sentLineOffset = h.droppedLines + h.lines.length;

  if (
    h.status !== state.lastStatus ||
    h.queuePosition !== state.lastQueuePosition ||
    h.pendingPrompts.length !== state.lastPendingCount
  ) {
    if (!(await emitStatus(stream, h, state.msgCursor))) return false;
    state.lastStatus = h.status;
    state.lastQueuePosition = h.queuePosition;
    state.lastPendingCount = h.pendingPrompts.length;
  }

  // Chained prompts starting (genuine transitions only).
  while (state.lastStartedCount < h.startedPrompts.length) {
    const cardHtml = renderPromptCard(h.startedPrompts[state.lastStartedCount]);
    if (!(await emit(stream, "prompt", cardHtml, state.msgCursor)))
      return false;
    state.lastStartedCount++;
  }

  // Flush new preview lines. Active runs flush incrementally; the first
  // terminal detection does one final flush so lines produced just before
  // process exit aren't lost.
  if (!isTerminalStatus(h.status) || !state.flushedTerminal) {
    if (
      !(await flushPreview(
        stream,
        h.lines,
        h.droppedLines,
        state.sentLineOffset,
        state.msgCursor,
      ))
    )
      return false;
    state.sentLineOffset = h.droppedLines + h.lines.length;
    if (isTerminalStatus(h.status)) state.flushedTerminal = true;
  }

  return true;
};

const registerStreamRoutes = (app: Hono, ctx: ServerContext): void => {
  // Unified session event stream. The DB is the source of truth for committed
  // messages; in-memory NDJSON lines are a transient preview shown below the
  // transcript while a run is active. The stream never closes itself — it
  // shifts from active polling (50 ms) to idle polling (tailPollMs) and stays
  // open until the client disconnects.
  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const initial = getSession(ctx.db, id);
    if (initial === undefined) return c.text("Session not found", 404);

    const cursor = resumeCursor(
      c.req.header("last-event-id") ?? "",
      c.req.query("cursor"),
    );

    return streamSSE(c, async (stream) => {
      const baselineRows = listMessages(ctx.db, id);
      const state: PollState = {
        snapshots: baselineRows.map((row) => row.content_json),
        msgCursor: baselineRows.length,
        lastName: initial.name,
        lastUpdated: initial.updated_at,
        previewCleared: false,
        lastStatus: undefined,
        lastQueuePosition: undefined,
        lastPendingCount: undefined,
        lastStartedCount: 0,
        sentLineOffset: 0,
        flushedTerminal: false,
      };

      const catchup = renderCatchup(baselineRows.map(parseMessage), cursor);
      if (
        !(await emit(
          stream,
          "messages",
          JSON.stringify({ entries: catchup, cursor: state.msgCursor }),
          state.msgCursor,
        ))
      )
        return;

      const handle = getHandle(ctx.runner, id);
      const active = handle !== undefined && !isTerminalStatus(handle.status);

      if (handle !== undefined) {
        if (!(await emitStatus(stream, handle, state.msgCursor))) return;
        state.lastStatus = handle.status;
        state.lastQueuePosition = handle.queuePosition;
        state.lastPendingCount = handle.pendingPrompts.length;
        state.lastStartedCount = handle.startedPrompts.length;
      } else if (
        !(await emit(
          stream,
          "status",
          JSON.stringify({ status: "idle" }),
          state.msgCursor,
        ))
      )
        return;

      if (active && handle !== undefined) {
        if (
          !(await flushPreview(
            stream,
            handle.lines,
            handle.droppedLines,
            0,
            state.msgCursor,
          ))
        )
          return;
        state.sentLineOffset = handle.droppedLines + handle.lines.length;
      }

      let polls = 0;
      while (!stream.aborted && polls < ctx.maxTailPolls) {
        const probe = getHandle(ctx.runner, id);
        const probeActive =
          probe !== undefined && !isTerminalStatus(probe.status);
        await stream.sleep(probeActive ? 50 : ctx.tailPollMs);
        if (stream.aborted) return;
        polls++;
        if (!(await pollDb(stream, ctx, id, state))) return;
        if (!(await pollRunner(stream, ctx, id, state))) return;
      }
    });
  });
};

export { registerStreamRoutes };
