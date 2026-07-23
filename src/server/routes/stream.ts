import { type Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getSession, listMessages } from "../../db.js";
import { parseMessage } from "../../format/index.js";
import { getHandle, isTerminalStatus } from "../../runner/index.js";
import { renderMessage } from "../../views/message-blocks.js";
import { renderPromptCard } from "../../views/transcript.js";
import type { ServerContext } from "../context.js";
import { emit, emitMeta, emitStatus, flushPreview } from "../sse.js";

// Resume cursor: Last-Event-ID (auto-sent by EventSource on reconnect) takes
// precedence over the explicit ?cursor= from the initial connect.
const resumeCursor = (headerId: string, query?: string): number => {
  if (/^\d+$/.test(headerId)) return Number(headerId);
  if (query !== undefined && /^\d+$/.test(query)) return Number(query);
  return 0;
};

const registerStreamRoutes = (app: Hono, ctx: ServerContext): void => {
  // Unified session event stream. Replaces the former /stream (runner-only)
  // and /tail (DB-only) endpoints. The DB is the single source of truth for
  // committed messages; in-memory NDJSON lines are a transient preview shown
  // below the transcript while a run is active. The stream never closes
  // itself — it transitions from active-polling (50 ms) to idle-polling
  // (tailPollMs) and stays open until the client disconnects.
  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const initial = getSession(ctx.db, id);
    if (initial === undefined) return c.text("Session not found", 404);

    const cursor = resumeCursor(
      c.req.header("last-event-id") ?? "",
      c.req.query("cursor"),
    );

    return streamSSE(c, async (stream) => {
      // --- Catch-up: reconcile DB messages from the resume cursor ---
      const baselineRows = listMessages(ctx.db, id);
      const baselineMessages = baselineRows.map(parseMessage);
      const catchup: { index: number; html: string }[] = [];
      for (let i = cursor; i < baselineMessages.length; i++) {
        const html = renderMessage(baselineMessages[i], i);
        if (html !== "") catchup.push({ index: i, html });
      }
      let msgCursor = baselineRows.length;
      if (
        !(await emit(
          stream,
          "messages",
          JSON.stringify({ entries: catchup, cursor: msgCursor }),
          msgCursor,
        ))
      )
        return;

      // Snapshot content_json to detect in-place edits, not just appends.
      let snapshots = baselineRows.map((row) => row.content_json);
      let lastName = initial.name;
      let lastUpdated = initial.updated_at;

      // --- Runner state (transient preview + status) ---
      const handle = getHandle(ctx.runner, id);
      const active = handle !== undefined && !isTerminalStatus(handle.status);

      // Initial status so the client lands on the correct state immediately.
      if (handle !== undefined) {
        if (!(await emitStatus(stream, handle, msgCursor))) return;
      } else if (
        !(await emit(
          stream,
          "status",
          JSON.stringify({ status: "idle" }),
          msgCursor,
        ))
      )
        return;

      // Delta-tracking fields for the runner poll.
      let lastStatus = handle?.status;
      let lastQueuePosition = handle?.queuePosition;
      let lastPendingCount = handle?.pendingPrompts.length;
      let lastStartedCount = handle?.startedPrompts.length ?? 0;

      // Preview line offset (ring-buffer-aware absolute sequence number).
      let sentLineOffset = 0;
      // Ensures a single final flush of any lines produced just before the
      // process exited (the last NDJSON line can arrive after the poll that
      // last saw an active handle).
      let flushedTerminal = false;
      if (active && handle !== undefined) {
        if (
          !(await flushPreview(
            stream,
            handle.lines,
            handle.droppedLines,
            0,
            msgCursor,
          ))
        )
          return;
        sentLineOffset = handle.droppedLines + handle.lines.length;
      }

      // --- Poll loop: runs until the client disconnects ---
      let polls = 0;
      while (!stream.aborted && polls < ctx.maxTailPolls) {
        // Adapt the interval: fast while a run is active, slow when idle.
        const probe = getHandle(ctx.runner, id);
        const probeActive =
          probe !== undefined && !isTerminalStatus(probe.status);
        await stream.sleep(probeActive ? 50 : ctx.tailPollMs);
        if (stream.aborted) return;
        polls++;

        // A. DB poll — authoritative message state.
        const session = getSession(ctx.db, id);
        if (session === undefined) {
          // Session deleted mid-connection: signal and close.
          await emit(
            stream,
            "status",
            JSON.stringify({ status: "deleted" }),
            msgCursor,
          );
          return;
        }

        const rows = listMessages(ctx.db, id);
        const messages = rows.map(parseMessage);
        let dbChanged = false;
        let previewCleared = false;

        // New messages → append; committed DB rows supersede preview lines.
        if (rows.length > snapshots.length) {
          for (let i = snapshots.length; i < messages.length; i++) {
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
              return;
          }
          msgCursor = rows.length;
          previewCleared = true;
          if (!(await emit(stream, "preview-clear", "", msgCursor))) return;
        }

        // In-place content edits → replace.
        const common = Math.min(snapshots.length, rows.length);
        for (let i = 0; i < common; i++) {
          if (rows[i].content_json === snapshots[i]) continue;
          const html = renderMessage(messages[i], i);
          if (
            html !== "" &&
            !(await emit(
              stream,
              "replace",
              JSON.stringify({ index: i, html }),
              msgCursor,
            ))
          )
            return;
          dbChanged = true;
        }

        snapshots = rows.map((row) => row.content_json);

        // Session rename (goose derives a title mid-run).
        if (session.name !== lastName) {
          lastName = session.name;
          if (
            !(await emit(
              stream,
              "rename",
              JSON.stringify({ name: session.name }),
              msgCursor,
            ))
          )
            return;
        }

        // Updated-at meta chip.
        if (session.updated_at !== lastUpdated) {
          lastUpdated = session.updated_at;
          dbChanged = true;
        }
        if (dbChanged && !(await emitMeta(stream, session, msgCursor))) return;

        // B. Runner poll — transient preview + status deltas.
        const h = getHandle(ctx.runner, id);

        // After a DB catch-up, reset the preview offset so only genuinely
        // new lines (produced after the clear) are emitted.
        if (previewCleared && h !== undefined)
          sentLineOffset = h.droppedLines + h.lines.length;

        if (h !== undefined) {
          // Status / queue / pending-count shift.
          if (
            h.status !== lastStatus ||
            h.queuePosition !== lastQueuePosition ||
            h.pendingPrompts.length !== lastPendingCount
          ) {
            if (!(await emitStatus(stream, h, msgCursor))) return;
            lastStatus = h.status;
            lastQueuePosition = h.queuePosition;
            lastPendingCount = h.pendingPrompts.length;
          }

          // Chained prompts starting → prompt card (genuine transitions only).
          while (lastStartedCount < h.startedPrompts.length) {
            const cardHtml = renderPromptCard(
              h.startedPrompts[lastStartedCount],
            );
            if (!(await emit(stream, "prompt", cardHtml, msgCursor))) return;
            lastStartedCount++;
          }

          // Flush new NDJSON preview lines. While the run is active this is
          // incremental; on the first terminal detection we do one final
          // flush so lines produced in the gap between the last active poll
          // and process exit aren't lost.
          if (!isTerminalStatus(h.status) || !flushedTerminal) {
            if (
              !(await flushPreview(
                stream,
                h.lines,
                h.droppedLines,
                sentLineOffset,
                msgCursor,
              ))
            )
              return;
            sentLineOffset = h.droppedLines + h.lines.length;
            if (isTerminalStatus(h.status)) flushedTerminal = true;
          }
        }
        // A run that just transitioned to terminal has already had its
        // status emitted above; the next iteration drops to idle polling.
        // No done event, no re-render — the committed DB messages already
        // reflect the final state.
      }
    });
  });
};

export { registerStreamRoutes };
