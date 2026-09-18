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
import { parseForm } from "../forms.js";
import { param, queryValue, sendHtml } from "../http.js";

const REQUIRED_ERROR = "A title and prompt body are required.";

const readInput = (body: Record<string, unknown>): PromptInput => ({
  title: typeof body.title === "string" ? body.title : "",
  body: typeof body.body === "string" ? body.body : "",
  category: typeof body.category === "string" ? body.category : undefined,
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

  app.get("/prompts", (req, reply) => {
    const grouped = queryValue(req, "grouped") === "1";
    const sortBy: PromptSort =
      queryValue(req, "sort") === "usage" ? "usage" : "order";
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
  app.post("/prompts/reorder", async (req, reply) => {
    const body = await parseForm(req);
    const raw = typeof body.order === "string" ? body.order : "";
    const ids = raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    if (ids.length > 0) reorderPrompts(prompts, ids);
    return reply.code(200).send("");
  });

  // Inline save form, loaded into the save slot on demand.
  app.get("/prompts/new", (_req, reply) =>
    sendHtml(reply, <PromptSaveForm agentName={ctx.profile.agentName} />),
  );

  app.post("/prompts", async (req, reply) => {
    const input = readInput(await parseForm(req));
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

  app.get("/prompts/:id/card", (req, reply) => {
    const prompt = getPrompt(prompts, param(req, "id"));
    if (prompt === undefined) return reply.callNotFound();
    return sendHtml(reply, <PromptCard prompt={prompt} />);
  });

  app.get("/prompts/:id/edit", (req, reply) => {
    const prompt = getPrompt(prompts, param(req, "id"));
    if (prompt === undefined) return reply.callNotFound();
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

  app.put("/prompts/:id", async (req, reply) => {
    const id = param(req, "id");
    const input = readInput(await parseForm(req));
    const existing = getPrompt(prompts, id);
    if (existing === undefined) return reply.callNotFound();
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
    if (updated === undefined) return reply.callNotFound();
    return sendHtml(reply, <PromptCard prompt={updated} />);
  });

  // Empty body + outerHTML swap removes the card from the DOM.
  app.delete("/prompts/:id", (req, reply) => {
    deletePrompt(prompts, param(req, "id"));
    return reply.code(200).send("");
  });
};

export { registerPromptRoutes };
