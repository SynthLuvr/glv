import type { FastifyInstance } from "fastify";
import type { PromptSort } from "../../prompts/db.js";
import {
  deletePrompt,
  getPrompt,
  listCategories,
  listPrompts,
  reorderPrompts,
} from "../../prompts/db.js";
import {
  PromptCard,
  PromptEditForm,
  PromptLibrary,
  PromptSaveForm,
} from "../../views/prompt-library.js";
import type { ServerContext } from "../context.js";
import { fieldString, parseForm } from "../forms.js";
import { queryValue, sendHtml, sendNotFound, sendText } from "../http.js";
import { createSavedPrompt, updateSavedPrompt } from "../prompt-operations.js";

// The prompts store is optional (tests may omit it); when absent no routes
// are registered, so requests fall through to a 404.
const registerPromptRoutes = (
  app: FastifyInstance,
  ctx: ServerContext,
): void => {
  const prompts = ctx.prompts;

  if (prompts === undefined) return;

  app.get("/prompts", (request, reply) => {
    const grouped = queryValue(request, "grouped") === "1";
    const sortBy: PromptSort =
      queryValue(request, "sort") === "usage" ? "usage" : "order";
    return sendHtml(
      reply,
      <PromptLibrary
        prompts={listPrompts(prompts, sortBy)}
        categories={listCategories(prompts)}
        grouped={grouped}
        sortBy={sortBy}
      />,
    );
  });

  // Persists a manual reordering from drag-and-drop. Accepts a single
  // comma-separated `order` field of ids; assigns sort_order by position.
  // Returns an empty 200 — the DOM is already reordered client-side.
  app.post("/prompts/reorder", async (request, reply) => {
    const body = await parseForm(request);
    const raw = fieldString(body, "order");
    const ids = raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    if (ids.length > 0) reorderPrompts(prompts, ids);
    return sendText(reply, "");
  });

  // Inline save form, loaded into the save slot on demand.
  app.get("/prompts/new", (_request, reply) =>
    sendHtml(reply, <PromptSaveForm agentName={ctx.agentNames} />),
  );

  app.post("/prompts", async (request, reply) => {
    const result = createSavedPrompt(prompts, await parseForm(request));
    if (!result.ok)
      return sendHtml(
        reply,
        <PromptSaveForm
          agentName={ctx.agentNames}
          title={result.input.title}
          body={result.input.body}
          category={result.input.category ?? ""}
          error={result.error}
        />,
      );
    // No in-place content: the save slot is cleared while the refreshed
    // library swaps in out-of-band.
    return sendHtml(
      reply,
      <PromptLibrary
        prompts={listPrompts(prompts)}
        categories={listCategories(prompts)}
        oob
      />,
    );
  });

  app.get<{ Params: { id: string } }>("/prompts/:id/card", (request, reply) => {
    const prompt = getPrompt(prompts, request.params.id);
    if (prompt === undefined) return sendNotFound(reply);
    return sendHtml(reply, <PromptCard prompt={prompt} />);
  });

  app.get<{ Params: { id: string } }>("/prompts/:id/edit", (request, reply) => {
    const prompt = getPrompt(prompts, request.params.id);
    if (prompt === undefined) return sendNotFound(reply);
    return sendHtml(
      reply,
      <PromptEditForm
        id={prompt.id}
        title={prompt.title}
        body={prompt.body}
        category={prompt.category ?? ""}
      />,
    );
  });

  app.put<{ Params: { id: string } }>(
    "/prompts/:id",
    async (request, reply) => {
      const id = request.params.id;
      const result = updateSavedPrompt(prompts, id, await parseForm(request));
      if (!result.ok) {
        if (result.status === 404) return sendNotFound(reply);
        return sendHtml(
          reply,
          <PromptEditForm
            id={id}
            title={result.input.title}
            body={result.input.body}
            category={result.input.category ?? ""}
            error={result.error}
          />,
        );
      }
      return sendHtml(reply, <PromptCard prompt={result.prompt} />);
    },
  );

  // Empty body + outerHTML swap removes the card from the DOM.
  app.delete<{ Params: { id: string } }>("/prompts/:id", (request, reply) => {
    deletePrompt(prompts, request.params.id);
    return sendText(reply, "");
  });
};

export { registerPromptRoutes };
