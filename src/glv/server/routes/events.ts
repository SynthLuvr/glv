import type { FastifyInstance } from "fastify";
import { feedEventData } from "../../sse-events.js";
import type { ServerContext } from "../context.js";
import { VIEWER_FILTER } from "../context.js";
import { emit, streamSse } from "../sse.js";
import { activeStatuses, nameDeltas, statusDeltas } from "../status.js";

// Snapshot every sidebar session's name — not just runner-managed ids —
// because a CLI-started session is never registered, yet the agent still renames
// it once it derives a title.
const sidebarNames = (ctx: ServerContext): Map<string, string> =>
  new Map(ctx.sessions.listSessions(VIEWER_FILTER).map((s) => [s.id, s.name]));

// Streams status deltas for all active runs — not just the one the detail
// pane watches — to drive the sidebar's running indicators and live session
// names.
const registerEventsRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  app.get("/events/status", { sse: "only" }, (_request, reply) =>
    streamSse(reply, async (stream) => {
      let last = activeStatuses(ctx.runner);
      // The agent renames a session mid-run, so track names to push updates.
      let lastNames = sidebarNames(ctx);
      let polls = 0;

      const emitRenameDeltas = async (
        names: Iterable<[string, string]>,
      ): Promise<void> => {
        for (const [id, name] of names)
          await emit(
            stream,
            "rename",
            feedEventData("rename", { sessionId: id, name }),
          );
      };

      // The connect handshake answers "what is", not "what changed": the
      // active set travels on `sync` and every sidebar name on one `names`
      // snapshot, so a third-party listener can render the baseline without
      // pretending each entry was renamed. `rename` below stays reserved
      // for real deltas.
      await emit(stream, "sync", feedEventData("sync", [...last.keys()]));
      await emit(
        stream,
        "names",
        feedEventData(
          "names",
          [...lastNames].map(([sessionId, name]) => ({ sessionId, name })),
        ),
      );

      while (!stream.aborted && polls < ctx.maxStatusPolls) {
        polls++;
        await stream.sleep(ctx.statusPollMs);
        if (stream.aborted) return;

        const now = activeStatuses(ctx.runner);
        for (const [id, status] of statusDeltas(last, now))
          await emit(
            stream,
            "status",
            feedEventData("status", { sessionId: id, status }),
          );
        last = now;

        const currentNames = sidebarNames(ctx);
        await emitRenameDeltas(nameDeltas(lastNames, currentNames));
        lastNames = currentNames;
      }
      // Signal completion so the client tears down instead of auto-reconnecting
      // into a fresh poll loop (a reconnect storm).
      await emit(stream, "done", "closed");
    }),
  );
};

export { registerEventsRoutes };
