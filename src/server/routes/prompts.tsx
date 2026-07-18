import { type Hono } from "hono";
import { Fragment } from "hono/jsx";
import type { PromptInput } from "../../prompts/db.js";
import {
  createPrompt,
  deletePrompt,
  getPrompt,
  listCategories,
  listPrompts,
  updatePrompt,
} from "../../prompts/db.js";
import {
  PromptCard,
  PromptEditForm,
  PromptLibrary,
  PromptSaveForm,
} from "../../views/new-session.js";
import type { AppEnv, ServerContext } from "../context.js";

const REQUIRED_ERROR = "A title and prompt body are required.";

const readInput = (body: Record<string, unknown>): PromptInput => {
  const title = typeof body.title === "string" ? body.title : "";
  const promptBody = typeof body.body === "string" ? body.body : "";
  const category =
    typeof body.category === "string" ? body.category : undefined;
  return { title, body: promptBody, category };
};

const isValid = (input: PromptInput): boolean =>
  input.title.trim() !== "" && input.body.trim() !== "";

// All routes return HTML fragments for htmx to swap, consistent with the rest
// of the app. The prompts store is optional (tests may omit it); when absent
// the library is simply inert, so handlers 404 rather than throw.
const registerPromptRoutes = (app: Hono<AppEnv>, ctx: ServerContext): void => {
  const prompts = ctx.prompts;

  app.get("/prompts", (c) => {
    if (prompts === undefined) return c.notFound();
    return c.html(
      <PromptLibrary
        prompts={listPrompts(prompts)}
        categories={listCategories(prompts)}
      />,
    );
  });

  // Inline save form, loaded into the save slot on demand.
  app.get("/prompts/new", (c) => {
    if (prompts === undefined) return c.notFound();
    return c.html(<PromptSaveForm />);
  });

  app.post("/prompts", async (c) => {
    if (prompts === undefined) return c.notFound();
    const input = readInput(await c.req.parseBody());
    if (!isValid(input))
      return c.html(
        <PromptSaveForm
          title={input.title}
          body={input.body}
          category={input.category ?? ""}
          error={REQUIRED_ERROR}
        />,
      );
    createPrompt(prompts, input);
    // On success the slot target receives no in-place content (cleared) while
    // the refreshed library swaps in out-of-band.
    return c.html(
      <Fragment>
        <PromptLibrary
          prompts={listPrompts(prompts)}
          categories={listCategories(prompts)}
          oob
        />
      </Fragment>,
    );
  });

  app.get("/prompts/:id/card", (c) => {
    if (prompts === undefined) return c.notFound();
    const prompt = getPrompt(prompts, c.req.param("id"));
    if (prompt === undefined) return c.notFound();
    return c.html(<PromptCard prompt={prompt} />);
  });

  app.get("/prompts/:id/edit", (c) => {
    if (prompts === undefined) return c.notFound();
    const prompt = getPrompt(prompts, c.req.param("id"));
    if (prompt === undefined) return c.notFound();
    return c.html(
      <PromptEditForm
        id={prompt.id}
        title={prompt.title}
        body={prompt.body}
        category={prompt.category ?? ""}
      />,
    );
  });

  app.put("/prompts/:id", async (c) => {
    if (prompts === undefined) return c.notFound();
    const id = c.req.param("id");
    const input = readInput(await c.req.parseBody());
    const existing = getPrompt(prompts, id);
    if (existing === undefined) return c.notFound();
    if (!isValid(input))
      return c.html(
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
    if (updated === undefined) return c.notFound();
    return c.html(<PromptCard prompt={updated} />);
  });

  // Empty body + outerHTML swap removes the card from the DOM.
  app.delete("/prompts/:id", (c) => {
    if (prompts === undefined) return c.notFound();
    deletePrompt(prompts, c.req.param("id"));
    return c.body(null, 200);
  });
};

export { registerPromptRoutes };
