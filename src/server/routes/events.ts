import { type Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv, ServerContext } from "../context.js";
import { emit } from "../sse.js";
import { activeStatuses, statusDeltas } from "../status.js";

// Streams status deltas for all active runs — not just the one the detail
// pane watches — to drive the sidebar's running indicators.
const registerEventsRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  app.get("/events/status", (c) =>
    streamSSE(c, async (stream) => {
      let last = activeStatuses(ctx.runner);
      let polls = 0;

      if (!(await emit(stream, "sync", JSON.stringify([...last.keys()]))))
        return;

      while (!stream.aborted && polls < ctx.maxStatusPolls) {
        polls++;
        await stream.sleep(ctx.statusPollMs);
        if (stream.aborted) return;

        const now = activeStatuses(ctx.runner);
        for (const [id, status] of statusDeltas(last, now))
          if (
            !(await emit(
              stream,
              "status",
              JSON.stringify({ sessionId: id, status }),
            ))
          )
            return;
        last = now;
      }
    }),
  );
};

export { registerEventsRoutes };
