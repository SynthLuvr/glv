import { type Elysia } from "elysia";
import { getSession, listMessages, type SessionRow } from "../../db.js";
import { type ParsedMessage, parseMessage } from "../../format/index.js";
import { getHandle, isTerminalStatus } from "../../runner/index.js";
import { renderMessage } from "../../views/message-blocks.js";
import { renderPromptCard } from "../../views/transcript.js";
import type { ServerContext } from "../context.js";
import { text } from "../http.js";
import {
  type Frame,
  flushPreview,
  frame,
  metaFrame,
  sleep,
  statusFrame,
} from "../sse.js";

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
// Returns false once the session is gone (after signalling the client to close
// its EventSource), true to keep polling. Client disconnect tears the generator
// down via Elysia's stream handler, so no manual abort checks are needed.
const pollDb = async function* (
  ctx: ServerContext,
  id: string,
  state: PollState,
): AsyncGenerator<Frame, boolean> {
  const session = getSession(ctx.db, id);
  if (session === undefined) {
    yield frame(
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
      if (html !== "")
        yield frame("append", JSON.stringify({ index: i, html }), i + 1);
    }
    state.msgCursor = rows.length;
    state.previewCleared = true;
    yield frame("preview-clear", "", state.msgCursor);
  }

  // In-place content edits.
  const common = Math.min(state.snapshots.length, rows.length);
  for (let i = 0; i < common; i++) {
    if (rows[i].content_json === state.snapshots[i]) continue;
    const html = renderMessage(messages[i], i);
    if (html !== "")
      yield frame(
        "replace",
        JSON.stringify({ index: i, html }),
        state.msgCursor,
      );
    metaChanged = true;
  }
  state.snapshots = rows.map((row) => row.content_json);

  // Goose derives a real title mid-run; follow the rename.
  if (session.name !== state.lastName) {
    state.lastName = session.name;
    yield frame(
      "rename",
      JSON.stringify({ name: session.name }),
      state.msgCursor,
    );
  }

  if (session.updated_at !== state.lastUpdated) {
    state.lastUpdated = session.updated_at;
    metaChanged = true;
  }
  if (metaChanged) yield metaFrame(session, state.msgCursor);

  return true;
};

// Emits runner deltas — status/queue shifts, chained prompt cards, and NDJSON
// preview lines. Returns true to keep polling.
const pollRunner = async function* (
  ctx: ServerContext,
  id: string,
  state: PollState,
): AsyncGenerator<Frame, boolean> {
  const h = getHandle(ctx.runner, id);
  if (h === undefined) return true;

  // A DB catch-up just cleared the preview; rebase past any buffered lines
  // that belong to the now-committed message (they'd duplicate #messages).
  if (state.previewCleared)
    state.sentLineOffset = h.output.drain(state.sentLineOffset).nextSeq;

  if (
    h.status !== state.lastStatus ||
    h.queuePosition !== state.lastQueuePosition ||
    h.pendingPrompts.length !== state.lastPendingCount
  ) {
    yield statusFrame(h, state.msgCursor);
    state.lastStatus = h.status;
    state.lastQueuePosition = h.queuePosition;
    state.lastPendingCount = h.pendingPrompts.length;
  }

  // Chained prompts starting (genuine transitions only).
  while (state.lastStartedCount < h.startedPrompts.length) {
    const cardHtml = renderPromptCard(h.startedPrompts[state.lastStartedCount]);
    yield frame("prompt", cardHtml, state.msgCursor);
    state.lastStartedCount++;
  }

  // Flush new preview lines. Active runs flush incrementally; the first
  // terminal detection does one final flush so lines produced just before
  // process exit aren't lost.
  if (!isTerminalStatus(h.status) || !state.flushedTerminal) {
    state.sentLineOffset = yield* flushPreview(
      h.output,
      state.sentLineOffset,
      state.msgCursor,
    );
    if (isTerminalStatus(h.status)) state.flushedTerminal = true;
  }

  return true;
};

// Unified session event stream. The DB is the source of truth for committed
// messages; in-memory NDJSON lines are a transient preview shown below the
// transcript while a run is active. The stream shifts from active polling
// (50 ms) to idle polling (tailPollMs); it runs for up to maxTailPolls
// iterations then completes so the client can reconnect. Client disconnect
// tears the generator down immediately via Elysia's stream handler.
const sessionEventStream = async function* (
  ctx: ServerContext,
  id: string,
  initial: SessionRow,
  cursor: number,
): AsyncGenerator<Frame> {
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
  yield frame(
    "messages",
    JSON.stringify({ entries: catchup, cursor: state.msgCursor }),
    state.msgCursor,
  );

  const handle = getHandle(ctx.runner, id);
  const active = handle !== undefined && !isTerminalStatus(handle.status);

  if (handle !== undefined) {
    yield statusFrame(handle, state.msgCursor);
    state.lastStatus = handle.status;
    state.lastQueuePosition = handle.queuePosition;
    state.lastPendingCount = handle.pendingPrompts.length;
    state.lastStartedCount = handle.startedPrompts.length;
  } else
    yield frame("status", JSON.stringify({ status: "idle" }), state.msgCursor);

  if (active && handle !== undefined)
    state.sentLineOffset = yield* flushPreview(
      handle.output,
      0,
      state.msgCursor,
    );

  let polls = 0;
  while (polls < ctx.maxTailPolls) {
    const probe = getHandle(ctx.runner, id);
    const probeActive = probe !== undefined && !isTerminalStatus(probe.status);
    await sleep(probeActive ? 50 : ctx.tailPollMs);
    polls++;
    if (!(yield* pollDb(ctx, id, state))) return;
    if (!(yield* pollRunner(ctx, id, state))) return;
  }
};

const registerStreamRoutes = (app: Elysia, ctx: ServerContext): void => {
  app.get("/sessions/:id/events", (c) => {
    const id = c.params.id;
    const initial = getSession(ctx.db, id);
    if (initial === undefined) return text(c, "Session not found", 404);

    const cursor = resumeCursor(
      c.request.headers.get("last-event-id") ?? "",
      c.query.cursor,
    );

    return sessionEventStream(ctx, id, initial, cursor);
  });
};

export { registerStreamRoutes };
