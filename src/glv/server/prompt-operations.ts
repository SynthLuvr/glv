import type { DatabaseSync } from "node:sqlite";
import {
  createPrompt,
  getPrompt,
  type PromptInput,
  type SavedPrompt,
  updatePrompt,
} from "../prompts/db.js";
import { fieldString } from "./forms.js";

// The prompt-library operation layer: the validate-and-execute core the
// HTML prompt routes and the JSON /api/prompts endpoints share, so both
// surfaces run identical effects — the same pattern the session and
// cron surfaces already use. Failures come back as {ok: false, status,
// error} with the parsed input riding along, and each surface decides
// how to render them — an HTML form re-render or a JSON status code.

const REQUIRED_ERROR = "A title and prompt body are required.";

type PromptOperationFailure = {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
  /** The parsed fields, so the HTML surface can re-render its form. */
  readonly input: PromptInput;
};

type PromptSaveOutcome =
  | PromptOperationFailure
  | { readonly ok: true; readonly prompt: SavedPrompt };

// The fields both surfaces accept, straight from a parsed form body
// (multipart or urlencoded — parseForm has already normalized them):
// the same title, body, and optional category the browser's save and
// edit forms submit.
const readPromptInput = (body: Record<string, unknown>): PromptInput => ({
  title: fieldString(body, "title"),
  body: fieldString(body, "body"),
  category: fieldString(body, "category") || undefined,
});

const isValid = (input: PromptInput): boolean =>
  input.title.trim() !== "" && input.body.trim() !== "";

const notFound = (id: string, input: PromptInput): PromptOperationFailure => ({
  ok: false,
  status: 404,
  error: `No saved prompt ${id}.`,
  input,
});

const createSavedPrompt = (
  db: DatabaseSync,
  body: Record<string, unknown>,
): PromptSaveOutcome => {
  const input = readPromptInput(body);
  if (!isValid(input))
    return { ok: false, status: 422, error: REQUIRED_ERROR, input };
  return { ok: true, prompt: createPrompt(db, input) };
};

// 404 beats 422: an unknown id stays unknown no matter what the
// fields say (the HTML surface relied on the same order).
const updateSavedPrompt = (
  db: DatabaseSync,
  id: string,
  body: Record<string, unknown>,
): PromptSaveOutcome => {
  const input = readPromptInput(body);
  if (getPrompt(db, id) === undefined) return notFound(id, input);
  if (!isValid(input))
    return { ok: false, status: 422, error: REQUIRED_ERROR, input };
  updatePrompt(db, id, input);
  const updated = getPrompt(db, id);
  return updated === undefined
    ? notFound(id, input)
    : { ok: true, prompt: updated };
};

export { createSavedPrompt, updateSavedPrompt };
