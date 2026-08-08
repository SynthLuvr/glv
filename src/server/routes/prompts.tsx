import { type Elysia } from "elysia";
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
import { html, notFound, parseBody, send } from "../http.js";

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
const registerPromptRoutes = (app: Elysia, ctx: ServerContext): void => {
  const prompts = ctx.prompts;

  if (prompts === undefined) return;

  app.get("/prompts", (c) => {
    const grouped = c.query.grouped === "1";
    const sortBy: PromptSort = c.query.sort === "usage" ? "usage" : "order";
    return html(
      c,
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
  app.post("/prompts/reorder", async (c) => {
    const body = await parseBody(c);
    const raw = typeof body.order === "string" ? body.order : "";
    const ids = raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    if (ids.length > 0) reorderPrompts(prompts, ids);
    return send(c, null, 200);
  });

  // Inline save form, loaded into the save slot on demand.
  app.get("/prompts/new", (c) => html(c, <PromptSaveForm />));

  app.post("/prompts", async (c) => {
    const input = readInput(await parseBody(c));
    if (!isValid(input))
      return html(
        c,
        <PromptSaveForm
          title={input.title}
          body={input.body}
          category={input.category ?? ""}
          error={REQUIRED_ERROR}
        />,
      );
    createPrompt(prompts, input);
    // No in-place content: the save slot is cleared while the refreshed
    // library swaps in out-of-band.
    return html(
      c,
      <PromptLibrary
        prompts={listPrompts(prompts)}
        categories={listCategories(prompts)}
        oob
      />,
    );
  });

  app.get("/prompts/:id/card", (c) => {
    const prompt = getPrompt(prompts, c.params.id);
    if (prompt === undefined) return notFound(c);
    return html(c, <PromptCard prompt={prompt} />);
  });

  app.get("/prompts/:id/edit", (c) => {
    const prompt = getPrompt(prompts, c.params.id);
    if (prompt === undefined) return notFound(c);
    return html(
      c,
      <PromptEditForm
        id={prompt.id}
        title={prompt.title}
        body={prompt.body}
        category={prompt.category ?? ""}
      />,
    );
  });

  app.put("/prompts/:id", async (c) => {
    const id = c.params.id;
    const input = readInput(await parseBody(c));
    const existing = getPrompt(prompts, id);
    if (existing === undefined) return notFound(c);
    if (!isValid(input))
      return html(
        c,
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
    if (updated === undefined) return notFound(c);
    return html(c, <PromptCard prompt={updated} />);
  });

  // Empty body + outerHTML swap removes the card from the DOM.
  app.delete("/prompts/:id", (c) => {
    deletePrompt(prompts, c.params.id);
    return send(c, null, 200);
  });
};

export { registerPromptRoutes };
