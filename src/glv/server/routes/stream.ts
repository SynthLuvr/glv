import { type Hono } from "hono";
import {
  type ParsedMessage,
  parseMessage,
  pendingTool,
  type ToolRun,
} from "../../format/index.js";
import {
  getHandle,
  isTerminalStatus,
  type RunHandle,
} from "../../runner/index.js";
import { type MessageEntry, sessionEventData } from "../../sse-events.js";
import { renderMessage } from "../../views/message-blocks.js";
import { renderPromptCard } from "../../views/transcript.js";
import type { ServerContext } from "../context.js";
import {
  emit,
  emitMeta,
  emitStatus,
  flushPreview,
  type SseStream,
  streamSse,
} from "../sse.js";

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
  /** Tool call the newest rows say is in flight; undefined once answered. */
  pendingTool: ToolRun | undefined;
  /** Identity of pendingTool as last emitted, for delta detection. */
  lastToolKey: string;
};

// Resume cursor: stream.lastEventId (auto-sent by EventSource on reconnect)
// takes precedence over the ?cursor= query from the initial connect.
const parseCursor = (value: string | undefined): number | undefined =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;

const resumeCursor = (
  lastEventId: string | undefined,
  query?: string,
): number => parseCursor(lastEventId) ?? parseCursor(query) ?? 0;

const renderCatchup = (
  messages: ParsedMessage[],
  cursor: number,
): MessageEntry[] => {
  const deltas: MessageEntry[] = [];
  for (let i = cursor; i < messages.length; i++) {
    const html = renderMessage(messages[i], i);
    if (html !== "") deltas.push({ index: i, html });
  }
  return deltas;
};

// Identity of the in-flight tool call for delta detection: which tool,
// which request row, how many parallel calls, and the timeout. Elapsed
// time is client-side, so a steady call yields a steady key and no
// repeated status events. A tool is only in flight while the run is
// actually running — the same filter emitStatus applies.
const statusToolKey = (state: PollState, h: RunHandle): string => {
  if (h.status !== "running" || state.pendingTool === undefined) return "";
  const tool = state.pendingTool;
  return `${tool.name}|${tool.startMs}|${tool.count}|${tool.timeoutSec ?? ""}`;
};

// Records the status fields emitStatus just sent, so later polls only emit
// changes against this baseline.
const recordStatusBaseline = (state: PollState, h: RunHandle): void => {
  state.lastStatus = h.status;
  state.lastQueuePosition = h.queuePosition;
  state.lastPendingCount = h.pendingPrompts.length;
  state.lastToolKey = statusToolKey(state, h);
};

// Emits DB deltas — new messages, in-place edits, renames, and the meta chip.
// Returns false once the session is deleted; the deleted status signals the
// client to close its EventSource.
const pollDb = async (
  stream: SseStream,
  ctx: ServerContext,
  id: string,
  state: PollState,
): Promise<boolean> => {
  const session = ctx.sessions.getSession(id);
  if (session === undefined) {
    await emit(
      stream,
      "status",
      sessionEventData("status", { status: "deleted" }),
      state.msgCursor,
    );
    return false;
  }

  const rows = ctx.sessions.listMessages(id);
  const messages = rows.map(parseMessage);
  let metaChanged = false;
  state.previewCleared = false;

  // New rows supersede the transient preview: append, then clear it.
  if (rows.length > state.snapshots.length) {
    for (let i = state.snapshots.length; i < messages.length; i++) {
      const html = renderMessage(messages[i], i);
      if (html !== "")
        await emit(
          stream,
          "append",
          sessionEventData("append", { index: i, html }),
          i + 1,
        );
    }
    state.msgCursor = rows.length;
    state.previewCleared = true;
    await emit(stream, "preview-clear", "", state.msgCursor);
  }

  // In-place content edits.
  const common = Math.min(state.snapshots.length, rows.length);
  for (let i = 0; i < common; i++) {
    if (rows[i].content_json === state.snapshots[i]) continue;
    const html = renderMessage(messages[i], i);
    if (html !== "")
      await emit(
        stream,
        "replace",
        sessionEventData("replace", { index: i, html }),
        state.msgCursor,
      );
    metaChanged = true;
  }
  state.snapshots = rows.map((row) => row.content_json);
  // The tail moved, so re-derive which tool call (if any) is now in flight.
  state.pendingTool = pendingTool(messages);

  // The agent derives a real title mid-run; follow the rename.
  if (session.name !== state.lastName) {
    state.lastName = session.name;
    await emit(
      stream,
      "rename",
      sessionEventData("rename", { name: session.name }),
      state.msgCursor,
    );
  }

  if (session.updated_at !== state.lastUpdated) {
    state.lastUpdated = session.updated_at;
    metaChanged = true;
  }
  if (metaChanged) await emitMeta(stream, session, state.msgCursor);

  return true;
};

// Emits runner deltas — status/queue shifts, chained prompt cards, and NDJSON
// preview lines.
const pollRunner = async (
  stream: SseStream,
  ctx: ServerContext,
  id: string,
  state: PollState,
): Promise<void> => {
  const h = getHandle(ctx.runner, id);
  if (h === undefined) return;

  // A DB catch-up just cleared the preview; rebase past any buffered lines
  // that belong to the now-committed message (they'd duplicate #messages).
  // drain is a snapshot, so we only borrow its nextSeq.
  if (state.previewCleared)
    state.sentLineOffset = h.output.drain(state.sentLineOffset).nextSeq;

  if (
    h.status !== state.lastStatus ||
    h.queuePosition !== state.lastQueuePosition ||
    h.pendingPrompts.length !== state.lastPendingCount ||
    statusToolKey(state, h) !== state.lastToolKey
  ) {
    await emitStatus(stream, h, state.pendingTool, state.msgCursor);
    recordStatusBaseline(state, h);
  }

  // Chained prompts starting (genuine transitions only).
  while (state.lastStartedCount < h.startedPrompts.length) {
    const cardHtml = renderPromptCard(h.startedPrompts[state.lastStartedCount]);
    await emit(stream, "prompt", cardHtml, state.msgCursor);
    state.lastStartedCount++;
  }

  // Flush new preview lines. Active runs flush incrementally; the first
  // terminal detection does one final flush so lines produced just before
  // process exit aren't lost.
  if (!isTerminalStatus(h.status) || !state.flushedTerminal) {
    state.sentLineOffset = await flushPreview(
      stream,
      h.output,
      state.sentLineOffset,
      ctx.profile.streamEnvelope,
      state.msgCursor,
    );
    if (isTerminalStatus(h.status)) state.flushedTerminal = true;
  }
};

const registerStreamRoutes = (app: Hono, ctx: ServerContext): void => {
  // Unified session event stream. The DB is the source of truth for committed
  // messages; in-memory NDJSON lines are a transient preview shown below the
  // transcript while a run is active. The stream never closes itself — it
  // shifts from active polling (50 ms) to idle polling (tailPollMs) and stays
  // open until the client disconnects.
  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const initial = ctx.sessions.getSession(id);
    if (initial === undefined) return c.text("Session not found", 404);

    return streamSse(c, async (stream) => {
      const cursor = resumeCursor(stream.lastEventId, c.req.query("cursor"));

      const baselineRows = ctx.sessions.listMessages(id);
      const baselineMessages = baselineRows.map(parseMessage);
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
        pendingTool: pendingTool(baselineMessages),
        lastToolKey: "",
      };

      const catchup = renderCatchup(baselineMessages, cursor);
      await emit(
        stream,
        "messages",
        sessionEventData("messages", {
          entries: catchup,
          cursor: state.msgCursor,
        }),
        state.msgCursor,
      );

      const handle = getHandle(ctx.runner, id);
      const active = handle !== undefined && !isTerminalStatus(handle.status);

      if (handle !== undefined) {
        await emitStatus(stream, handle, state.pendingTool, state.msgCursor);
        recordStatusBaseline(state, handle);
        state.lastStartedCount = handle.startedPrompts.length;
      } else
        await emit(
          stream,
          "status",
          sessionEventData("status", { status: "idle" }),
          state.msgCursor,
        );

      if (active && handle !== undefined)
        state.sentLineOffset = await flushPreview(
          stream,
          handle.output,
          0,
          ctx.profile.streamEnvelope,
          state.msgCursor,
        );

      let polls = 0;
      while (!stream.aborted && polls < ctx.maxTailPolls) {
        const probe = getHandle(ctx.runner, id);
        const probeActive =
          probe !== undefined && !isTerminalStatus(probe.status);
        await stream.sleep(probeActive ? 50 : ctx.tailPollMs);
        if (stream.aborted) return;
        polls++;
        if (!(await pollDb(stream, ctx, id, state))) return;
        await pollRunner(stream, ctx, id, state);
      }
    });
  });
};

export { registerStreamRoutes };
