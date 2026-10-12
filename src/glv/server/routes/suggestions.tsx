import type { FastifyInstance, FastifyReply } from "fastify";
import {
  setSuggestionsEnabled,
  suggestionsEnabled,
} from "../../suggestions/db.js";
import { SuggestionsToggle } from "../../views/SidebarControls.js";
import type { ServerContext } from "../context.js";
import { sendHtml, sendNotFound } from "../http.js";

// The suggested-next-prompts switch: one POST flips the setting (the
// store is the source of truth; the watcher re-reads it on its next
// poll, so a flip applies with no restart or notify channel). The
// button swaps itself so the pressed state travels with the response —
// the same fragment serves an htmx swap and any non-htmx caller.
const registerSuggestionsRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  const toggle = (_request: unknown, reply: FastifyReply): FastifyReply => {
    if (ctx.suggestions === undefined) return sendNotFound(reply);
    const next = !suggestionsEnabled(ctx.suggestions);
    setSuggestionsEnabled(ctx.suggestions, next);
    return sendHtml(reply, <SuggestionsToggle enabled={next} />);
  };
  app.post("/suggestions/toggle", toggle);
};

export { registerSuggestionsRoutes };
