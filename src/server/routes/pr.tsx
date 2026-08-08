import { type Elysia } from "elysia";
import { resolvePrState, STATE_LABEL } from "../../pr-state.js";
import type { ServerContext } from "../context.js";
import { html } from "../http.js";

// Resolve live PR state via `gh` and return a colored badge for htmx to
// swap in. Unknown state → empty body, so the chip degrades to a plain link.
const registerPrRoutes = (app: Elysia, ctx: ServerContext): void => {
  app.get("/sessions/:id/pr-state", async (c) => {
    const url = c.query.url ?? "";
    const state = await resolvePrState(url, ctx.runPrState);
    if (state === "unknown") return html(c, "");
    return html(
      c,
      <span class={`pr-state pr-state-${state}`}>
        <span class="pr-dot" aria-hidden="true"></span>
        {STATE_LABEL[state]}
      </span>,
    );
  });
};

export { registerPrRoutes };
