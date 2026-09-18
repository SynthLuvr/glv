import type { FastifyInstance } from "fastify";
import { resolvePrState, STATE_LABEL } from "../../pr-state.js";
import type { ServerContext } from "../context.js";
import { queryValue, sendHtml } from "../http.js";

// Resolve live PR state via `gh` and return a colored badge for htmx to
// swap in. Unknown state → empty body, so the chip degrades to a plain link.
const registerPrRoutes = (app: FastifyInstance, ctx: ServerContext): void => {
  app.get("/sessions/:id/pr-state", async (req, reply) => {
    const url = queryValue(req, "url") ?? "";
    const state = await resolvePrState(url, ctx.runPrState);
    if (state === "unknown") return sendHtml(reply, "");
    return sendHtml(
      reply,
      <span class={`pr-state pr-state-${state}`}>
        <span class="pr-dot" aria-hidden="true"></span>
        {STATE_LABEL[state]}
      </span>,
    );
  });
};

export { registerPrRoutes };
