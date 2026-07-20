import { type Hono } from "hono";
import { resolvePrState, STATE_LABEL } from "../../pr.js";
import type { ServerContext } from "../context.js";

// Resolve live PR state via `gh` and return a colored badge for htmx to
// swap in. Unknown state → empty body, so the chip degrades to a plain link.
const registerPrRoutes = (app: Hono, ctx: ServerContext): void => {
  app.get("/sessions/:id/pr-state", async (c) => {
    const url = c.req.query("url") ?? "";
    const state = await resolvePrState(url, ctx.runPrState);
    if (state === "unknown") return c.html("");
    return c.html(
      <span class={`pr-state pr-state-${state}`}>
        <span class="pr-dot" aria-hidden="true"></span>
        {STATE_LABEL[state]}
      </span>,
    );
  });
};

export { registerPrRoutes };
