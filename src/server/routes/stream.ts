import { type Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getSession, listMessages } from "../../db.js";
import { parseMessage } from "../../format/index.js";
import { getHandle, isTerminalStatus } from "../../runner/index.js";
import { renderMessage } from "../../views/message-blocks.js";
import { renderPromptCard } from "../../views/transcript.js";
import type { AppEnv, ServerContext } from "../context.js";
import {
  emit,
  emitMeta,
  emitStatus,
  flushLines,
  flushMessages,
} from "../sse.js";

const registerStreamRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  app.get("/sessions/:id/stream", (c) => {
    const id = c.req.param("id");
    if (getSession(ctx.db, id) === undefined)
      return c.text("Session not found", 404);

    return streamSSE(c, async (stream) => {
      const handle = getHandle(ctx.runner, id);

      // Idle or terminal: flush catch-up output, then close.
      if (handle === undefined || isTerminalStatus(handle.status)) {
        if (handle !== undefined) await flushLines(stream, handle.lines, 0);
        await emit(stream, "done", handle?.status ?? "idle");
        return;
      }

      if (!(await emitStatus(stream, handle))) return;

      // Surface mid-run transitions (e.g. queued → running) so the client
      // isn't left on a stale status until the terminal re-render.
      let lastStatus = handle.status;
      // Emit a prompt card for each chained run as it starts — including any
      // that already started before this connection (replayed on first pass).
      let lastStartedCount = 0;
      let sent = 0;
      while (!isTerminalStatus(handle.status)) {
        if (stream.aborted) return;
        if (handle.status !== lastStatus) {
          if (!(await emitStatus(stream, handle))) return;
          lastStatus = handle.status;
        }
        while (lastStartedCount < handle.startedPrompts.length) {
          if (
            !(await emit(
              stream,
              "prompt",
              renderPromptCard(handle.startedPrompts[lastStartedCount]),
            ))
          )
            return;
          lastStartedCount++;
        }
        if (!(await flushLines(stream, handle.lines, sent))) return;
        sent = handle.lines.length;
        await stream.sleep(50);
      }

      await flushLines(stream, handle.lines, sent);
      await emit(
        stream,
        "status",
        JSON.stringify({
          status: handle.status,
          error: handle.error ?? null,
          pendingCount: handle.pendingPrompts.length,
        }),
      );
      await emit(stream, "done", handle.status);
    });
  });

  // Polls the shared database for messages appended or updated by any writer
  // (terminal, desktop, another CLI). Streams only deltas. Used only for
  // sessions the web app isn't actively running.
  app.get("/sessions/:id/tail", (c) => {
    const id = c.req.param("id");
    if (getSession(ctx.db, id) === undefined)
      return c.text("Session not found", 404);

    return streamSSE(c, async (stream) => {
      // Snapshot content_json to detect in-place edits, not just appends.
      let snapshots = listMessages(ctx.db, id).map((row) => row.content_json);
      let polls = 0;
      while (!stream.aborted && polls < ctx.maxTailPolls) {
        polls++;
        await stream.sleep(ctx.tailPollMs);
        if (stream.aborted) return;

        // A session deleted mid-connection leaves no terminal signal:
        // listMessages returns [], deltas flatten to nothing, and the loop
        // would spin forever. Tear the stream down so the client closes its
        // EventSource instead of reconnecting against a missing session.
        const session = getSession(ctx.db, id);
        if (session === undefined) {
          await emit(stream, "done", "deleted");
          return;
        }

        const rows = listMessages(ctx.db, id);
        const messages = rows.map(parseMessage);
        const common = Math.min(snapshots.length, rows.length);
        let changed = false;

        // Re-render rows whose content changed since the last poll.
        for (let i = 0; i < common; i++) {
          if (rows[i].content_json === snapshots[i]) continue;
          const html = renderMessage(messages[i], i);
          if (
            html !== "" &&
            !(await emit(stream, "replace", JSON.stringify({ index: i, html })))
          )
            return;
          changed = true;
        }

        if (rows.length > snapshots.length) {
          if (!(await flushMessages(stream, messages, snapshots.length)))
            return;
          changed = true;
        }

        snapshots = rows.map((row) => row.content_json);

        if (!changed) continue;
        if (!(await emitMeta(stream, session))) return;
      }
    });
  });
};

export { registerStreamRoutes };
