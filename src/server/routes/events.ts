import { type Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv, ServerContext } from "../context.js";
import { emit } from "../sse.js";
import {
  activeNames,
  activeStatuses,
  nameDeltas,
  statusDeltas,
} from "../status.js";

// Streams status deltas for all active runs — not just the one the detail
// pane watches — to drive the sidebar's running indicators and live session
// names.
const registerEventsRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  app.get("/events/status", (c) =>
    streamSSE(c, async (stream) => {
      let last = activeStatuses(ctx.runner);
      // Goose renames a session mid-run, so track names to push live updates.
      let lastNames = activeNames(ctx.db, last.keys());
      let polls = 0;

      const emitNames = async (
        names: Iterable<[string, string]>,
      ): Promise<boolean> => {
        for (const [id, name] of names)
          if (
            !(await emit(
              stream,
              "rename",
              JSON.stringify({ sessionId: id, name }),
            ))
          )
            return false;
        return true;
      };

      if (!(await emit(stream, "sync", JSON.stringify([...last.keys()]))))
        return;
      if (!(await emitNames(lastNames))) return;

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

        const currentNames = activeNames(ctx.db, now.keys());
        if (!(await emitNames(nameDeltas(lastNames, currentNames)))) return;
        lastNames = currentNames;
      }
    }),
  );
};

export { registerEventsRoutes };
