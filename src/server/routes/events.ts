import { type Elysia } from "elysia";
import { listSessions } from "../../db.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { type Frame, frame, sleep } from "../sse.js";
import { activeStatuses, nameDeltas, statusDeltas } from "../status.js";

// Snapshot every sidebar session's name — not just runner-managed ids —
// because a CLI-started session is never registered, yet goose still renames
// it once it derives a title.
const sidebarNames = (ctx: ServerContext): Map<string, string> =>
  new Map(listSessions(ctx.db, VIEWER_FILTER).map((s) => [s.id, s.name]));

const emitNames = async function* (
  names: Iterable<[string, string]>,
): AsyncGenerator<Frame> {
  for (const [id, name] of names)
    yield frame("rename", JSON.stringify({ sessionId: id, name }));
};

// Streams status deltas for all active runs — not just the one the detail
// pane watches — to drive the sidebar's running indicators and live session
// names. Ends after maxStatusPolls with a "done" event so the client tears
// down instead of auto-reconnecting into a fresh poll loop (a reconnect storm).
const statusFeed = async function* (ctx: ServerContext): AsyncGenerator<Frame> {
  let last = activeStatuses(ctx.runner);
  let lastNames = sidebarNames(ctx);
  let polls = 0;

  yield frame("sync", JSON.stringify([...last.keys()]));
  yield* emitNames(lastNames);

  while (polls < ctx.maxStatusPolls) {
    polls++;
    await sleep(ctx.statusPollMs);

    const now = activeStatuses(ctx.runner);
    for (const [id, status] of statusDeltas(last, now))
      yield frame("status", JSON.stringify({ sessionId: id, status }));
    last = now;

    const currentNames = sidebarNames(ctx);
    yield* emitNames(nameDeltas(lastNames, currentNames));
    lastNames = currentNames;
  }

  yield frame("done", "closed");
};

const registerEventsRoutes = (app: Elysia, ctx: ServerContext): void => {
  app.get("/events/status", () => statusFeed(ctx));
};

export { registerEventsRoutes };
