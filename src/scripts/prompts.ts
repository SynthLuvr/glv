(() => {
  // Client behaviour for the saved-prompt library: fill/run cards, save-form
  // pre-fill, and client-side filtering. Everything is scoped inside this
  // IIFE so it never collides with the global `htmx` ambient declaration
  // (stream.ts) or the top-level helpers in sibling scripts (rename.ts).
  type Htmx = { trigger: (...args: unknown[]) => void };

  const isHtmx = (value: unknown): value is Htmx =>
    typeof value === "object" &&
    value !== null &&
    "trigger" in value &&
    typeof value.trigger === "function";

  const globalHtmx = (): Htmx | undefined => {
    const g: unknown = globalThis;
    return typeof g === "object" && g !== null && "htmx" in g && isHtmx(g.htmx)
      ? g.htmx
      : undefined;
  };

  // The new-session form has no native action we can reuse, so trigger htmx
  // directly (mirrors rename.ts) with a requestSubmit fallback.
  const submitSessionForm = (form: HTMLFormElement | null): void => {
    if (form === null) return;
    const api = globalHtmx();
    if (api !== undefined) {
      api.trigger(form, "submit");
      return;
    }
    form.requestSubmit();
  };

  const mainTextarea = (): HTMLTextAreaElement | null =>
    document.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');

  const sessionForm = (): HTMLFormElement | null =>
    document.querySelector<HTMLFormElement>("form.new-session-form");

  const promptIdField = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('input[name="prompt_id"]');

  const setPromptId = (value: string): void => {
    const field = promptIdField();
    if (field !== null) field.value = value;
  };

  // Fills the textarea with a saved prompt and clears the prompt-id so a manual
  // "Start session" never bumps usage stats for a prompt the user only loaded.
  const usePrompt = (btn: HTMLElement): void => {
    const body = btn.dataset.promptBody ?? "";
    const main = mainTextarea();
    if (main !== null) {
      main.value = body;
      main.focus();
    }
    setPromptId("");
  };

  // Loads the prompt into the textarea, tags it with the prompt-id, and submits
  // the existing session form so all validation and the create/poll logic run
  // unchanged.
  const runPrompt = (btn: HTMLElement): void => {
    const main = mainTextarea();
    if (main !== null) main.value = btn.dataset.promptBody ?? "";
    setPromptId(btn.dataset.promptId ?? "");
    submitSessionForm(sessionForm());
  };

  const closeSaveSlot = (): void => {
    const slot = document.getElementById("prompt-save-slot");
    if (slot !== null) slot.innerHTML = "";
  };

  // After the save form loads via htmx, pre-fill its body from the current
  // textarea contents so the user is saving what they typed.
  const fillSaveBody = (): void => {
    const form = document.querySelector<HTMLFormElement>(
      '[data-prompt-form="save"]',
    );
    if (form === null) return;
    const bodyField = form.querySelector<HTMLTextAreaElement>(
      'textarea[name="body"]',
    );
    const titleField = form.querySelector<HTMLInputElement>(
      'input[name="title"]',
    );
    const main = mainTextarea();
    if (bodyField !== null && main !== null) bodyField.value = main.value;
    if (titleField !== null) titleField.focus();
  };

  type Detail = {
    requestConfig?: { path?: string };
    successful?: boolean;
  };

  const onAfterRequest = (e: Event): void => {
    const detail = (e as CustomEvent).detail as Detail | undefined;
    if (detail?.requestConfig?.path !== "/prompts/new") return;
    if (detail.successful) fillSaveBody();
  };

  // Document-level delegation survives the out-of-band library swaps that
  // saving and editing trigger, mirroring sidebar.ts / rename.ts.
  document.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const btn = el?.closest("[data-action]");
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.dataset.action ?? "";
    if (action === "use") usePrompt(btn);
    else if (action === "run") runPrompt(btn);
    else if (action === "close-save") closeSaveSlot();
    // "open-save" is handled by htmx; the body pre-fill runs after the swap.
  });

  // Editing the textarea by hand detaches it from any saved prompt, so the
  // prompt-id is dropped before the next submit.
  document.addEventListener("input", (e) => {
    if (e.target instanceof HTMLTextAreaElement && e.target.name === "prompt")
      setPromptId("");
  });

  // Client-side title/category filter: no server round-trip for a snappy match.
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (
      !(el instanceof HTMLInputElement) ||
      !el.classList.contains("prompt-filter")
    )
      return;
    const query = el.value.toLowerCase();
    const grid = document.querySelector("[data-prompt-grid]");
    if (grid === null) return;
    for (const card of grid.querySelectorAll<HTMLElement>(".prompt-card")) {
      const text = (card.textContent ?? "").toLowerCase();
      card.style.display = text.includes(query) ? "" : "none";
    }
  });

  document.addEventListener("htmx:afterRequest", onAfterRequest);
})();
