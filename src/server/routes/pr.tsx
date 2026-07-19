import { type Hono } from "hono";
import { resolvePrState, STATE_LABEL } from "../../pr.js";
import { getHandle, isTerminalStatus } from "../../runner/index.js";
import type { AppEnv, ServerContext } from "../context.js";

// Resolve live PR state via `gh` and return a colored badge for htmx to
// swap in. Unknown state → empty body, so the chip degrades to a plain link.
const registerPrRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  app.get("/sessions/:id/pr-state", async (c) => {
    const id = c.req.param("id");
    // A resolved badge ("Open") reads as "the run is finished", so while a
    // run is still active it would make an in-progress session look done on a
    // mid-run refresh. Return an empty body instead; the chip stays a plain
    // link and both the transcript and sidebar re-fetch once the run ends.
    const run = getHandle(ctx.runner, id);
    if (run !== undefined && !isTerminalStatus(run.status)) return c.html("");
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
