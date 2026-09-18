import type { FastifyInstance } from "fastify";
import type { PromptInput, PromptSort } from "../../prompts/db.js";
import {
  createPrompt,
  deletePrompt,
  getPrompt,
  listCategories,
  listPrompts,
  reorderPrompts,
  updatePrompt,
} from "../../prompts/db.js";
import {
  PromptCard,
  PromptEditForm,
  PromptLibrary,
  PromptSaveForm,
} from "../../views/prompt-library.js";
import type { ServerContext } from "../context.js";
import { fieldString, parseForm } from "../forms.js";
import { queryValue, sendHtml, sendNotFound } from "../http.js";

const REQUIRED_ERROR = "A title and prompt body are required.";

const readInput = (body: Record<string, unknown>): PromptInput => ({
  title: fieldString(body, "title"),
  body: fieldString(body, "body"),
  category: fieldString(body, "category") || undefined,
});

const isValid = (input: PromptInput): boolean =>
  input.title.trim() !== "" && input.body.trim() !== "";

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
    return reply.status(200).type("text/plain; charset=utf-8").send("");
  });

  // Inline save form, loaded into the save slot on demand.
  app.get("/prompts/new", (_request, reply) =>
    sendHtml(reply, <PromptSaveForm agentName={ctx.profile.agentName} />),
  );

  app.post("/prompts", async (request, reply) => {
    const input = readInput(await parseForm(request));
    if (!isValid(input))
      return sendHtml(
        reply,
        <PromptSaveForm
          agentName={ctx.profile.agentName}
          title={input.title}
          body={input.body}
          category={input.category ?? ""}
          error={REQUIRED_ERROR}
        />,
      );
    createPrompt(prompts, input);
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
      const input = readInput(await parseForm(request));
      const existing = getPrompt(prompts, id);
      if (existing === undefined) return sendNotFound(reply);
      if (!isValid(input))
        return sendHtml(
          reply,
          <PromptEditForm
            id={id}
            title={input.title}
            body={input.body}
            category={input.category ?? ""}
            error={REQUIRED_ERROR}
          />,
        );
      updatePrompt(prompts, id, input);
      const updated = getPrompt(prompts, id);
      if (updated === undefined) return sendNotFound(reply);
      return sendHtml(reply, <PromptCard prompt={updated} />);
    },
  );

  // Empty body + outerHTML swap removes the card from the DOM.
  app.delete<{ Params: { id: string } }>("/prompts/:id", (request, reply) => {
    deletePrompt(prompts, request.params.id);
    return reply.status(200).type("text/plain; charset=utf-8").send("");
  });
};

export { registerPromptRoutes };
