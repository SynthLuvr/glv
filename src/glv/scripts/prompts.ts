import {
  findUnknownPlaceholders,
  substitutePlaceholders,
  today,
} from "../prompts/template.js";
import { getHtmx, htmxRequestDetail } from "./htmx.js";
import { fillPromptInput } from "./shared.js";

(() => {
  // The new-session form has no native action we can reuse, so trigger htmx
  // directly (mirrors rename.ts) with a requestSubmit fallback.
  const submitSessionForm = (form: HTMLFormElement | null): void => {
    if (form === null) return;
    const api = getHtmx();
    if (api !== undefined) {
      api.trigger(form, "submit");
      return;
    }
    form.requestSubmit();
  };

  // Scoped to the new-session form so this never matches the in-session
  // follow-up textarea (also name="prompt").
  const mainTextarea = (): HTMLTextAreaElement | null =>
    document.querySelector<HTMLTextAreaElement>(
      'form.new-session-form textarea[name="prompt"]',
    );

  const sessionForm = (): HTMLFormElement | null =>
    document.querySelector<HTMLFormElement>("form.new-session-form");

  const promptIdField = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('input[name="prompt_id"]');

  const setPromptId = (value: string): void => {
    const field = promptIdField();
    if (field !== null) field.value = value;
  };

  type PlaceholderValues = Record<string, string>;

  const fieldValue = (name: string): string => {
    const el = document.querySelector<HTMLInputElement>(
      `input[name="${name}"]`,
    );
    return el?.value ?? "";
  };

  // Known-placeholder context from the new-session form. Only non-empty
  // values are included so an unset {{repo}} (no repo selected) stays an
  // unknown the user must fill, rather than silently becoming empty.
  const newSessionContext = (): PlaceholderValues => {
    const values: PlaceholderValues = { date: today() };
    for (const name of ["working_dir", "repo", "branch"] as const) {
      const value = fieldValue(name);
      if (value !== "") values[name] = value;
    }
    return values;
  };

  // Opens a native <dialog> collecting a value for each unknown placeholder.
  // Resolves with the collected values, or null if the user cancelled.
  const collectUnknowns = (
    names: string[],
  ): Promise<PlaceholderValues | null> =>
    new Promise((resolve) => {
      // dialog.remove() never returns focus; capture the trigger first so it
      // can be restored on close for keyboard users.
      const active = document.activeElement;
      const trigger = active instanceof HTMLElement ? active : null;
      const dialog = document.createElement("dialog");
      dialog.className = "prompt-var-modal";
      const form = document.createElement("form");
      form.className = "prompt-var-form";
      const title = document.createElement("p");
      title.className = "prompt-var-title";
      title.textContent = "Fill in prompt variables";
      form.append(title);
      const inputs = new Map<string, HTMLInputElement>();
      for (const name of names) {
        const label = document.createElement("label");
        label.className = "prompt-var-field";
        const span = document.createElement("span");
        span.textContent = `{{${name}}}`;
        const input = document.createElement("input");
        input.type = "text";
        input.name = name;
        input.className = "form-input";
        input.required = true;
        inputs.set(name, input);
        label.append(span, input);
        form.append(label);
      }
      const actions = document.createElement("div");
      actions.className = "prompt-var-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "prompt-cancel-btn";
      cancel.textContent = "Cancel";
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "prompt-save-btn";
      submit.textContent = "Run";
      actions.append(cancel, submit);
      form.append(actions);
      dialog.append(form);
      document.body.append(dialog);
      dialog.showModal();

      const finish = (values: PlaceholderValues | null): void => {
        dialog.close();
        dialog.remove();
        trigger?.focus();
        resolve(values);
      };
      cancel.addEventListener("click", () => finish(null));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        const values: PlaceholderValues = {};
        for (const [name, input] of inputs) values[name] = input.value;
        finish(values);
      });
      // Escape key: native dialog cancel = abandon.
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish(null);
      });
      // Clicking the backdrop (the dialog itself, not its content) cancels.
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) finish(null);
      });
    });

  // Fills the textarea with a known-substituted prompt body and clears the
  // prompt-id so a manual "Start session" never bumps usage stats. Unknown
  // placeholders remain literal for the user to edit before starting.
  const usePrompt = (btn: HTMLElement): void => {
    const body = substitutePlaceholders(
      btn.dataset.promptBody ?? "",
      newSessionContext(),
    );
    const main = mainTextarea();
    if (main !== null) {
      fillPromptInput(main, body);
      main.focus();
    }
    setPromptId("");
  };

  // Substitutes known placeholders, prompts for any unknowns via a modal,
  // then submits the existing session form so all validation and the
  // create/poll logic run unchanged.
  const runPrompt = async (btn: HTMLElement): Promise<void> => {
    const values = newSessionContext();
    let body = substitutePlaceholders(btn.dataset.promptBody ?? "", values);
    const unknowns = findUnknownPlaceholders(body, values);
    if (unknowns.length > 0) {
      const collected = await collectUnknowns(unknowns);
      if (collected === null) return;
      body = substitutePlaceholders(body, collected);
    }
    const main = mainTextarea();
    fillPromptInput(main, body);
    // The input dispatch clears prompt_id; restore it before submit so usage
    // stats still bump.
    setPromptId(btn.dataset.promptId ?? "");
    submitSessionForm(sessionForm());
  };

  const followupTextarea = (btn: HTMLElement): HTMLTextAreaElement | null => {
    const bar = btn.closest<HTMLElement>("[data-prompt-bar]");
    return (
      bar?.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]') ?? null
    );
  };

  // Follow-up context: the session's working dir (exposed on the picker) plus
  // today's date. repo/branch are unknown here, so {{repo}} stays literal.
  const followupContext = (btn: HTMLElement): PlaceholderValues => {
    const values: PlaceholderValues = { date: today() };
    const picker = btn.closest<HTMLElement>(".followup-picker");
    const workingDir = picker?.dataset.workingDir ?? "";
    if (workingDir !== "") values.working_dir = workingDir;
    return values;
  };

  const followupUse = (btn: HTMLElement): void => {
    const body = substitutePlaceholders(
      btn.dataset.promptBody ?? "",
      followupContext(btn),
    );
    const textarea = followupTextarea(btn);
    if (textarea !== null) {
      fillPromptInput(textarea, body);
      textarea.focus();
    }
    const picker = btn.closest<HTMLElement>(".followup-picker");
    if (picker instanceof HTMLDetailsElement) picker.open = false;
  };

  let dragged: HTMLElement | null = null;

  const allCardIds = (): string =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "[data-prompt-grid] .prompt-card",
      ),
    ]
      .map((card) => card.dataset.promptId ?? "")
      .filter((id) => id !== "")
      .join(",");

  const persistOrder = (order: string): void => {
    void fetch("/prompts/reorder", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "HX-Request": "true",
      },
      body: `order=${encodeURIComponent(order)}`,
    });
  };

  // The card whose top-half the cursor is over; the dragged card is inserted
  // before it (or appended at the end when undefined).
  const dragAfter = (
    container: HTMLElement,
    y: number,
  ): Element | undefined => {
    let closest: { offset: number; element?: Element } = {
      offset: Number.NEGATIVE_INFINITY,
    };
    for (const child of container.querySelectorAll<HTMLElement>(
      ".prompt-card:not(.dragging)",
    )) {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset)
        closest = { offset, element: child };
    }
    return closest.element;
  };

  const onDragStart = (e: DragEvent): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const card = target.closest<HTMLElement>(".prompt-card");
    if (card === null) return;
    // Only a grab on the drag handle starts a reorder; clicks on buttons or
    // text selection are left untouched.
    if (target.closest(".prompt-drag-handle") === null) {
      e.preventDefault();
      return;
    }
    dragged = card;
    card.classList.add("dragging");
  };

  const onDragOver = (e: DragEvent): void => {
    if (dragged === null) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const grid = target.closest<HTMLElement>("[data-prompt-grid]");
    if (grid === null) return;
    // Restrict drops to the grid the card came from so a card never jumps
    // between category sections.
    if (dragged.parentElement !== grid) return;
    e.preventDefault();
    const after = dragAfter(grid, e.clientY);
    if (after === undefined) grid.append(dragged);
    else grid.insertBefore(dragged, after);
  };

  const onDrop = (e: DragEvent): void => {
    if (dragged !== null) e.preventDefault();
  };

  const onDragEnd = (): void => {
    if (dragged !== null) {
      dragged.classList.remove("dragging");
      dragged = null;
    }
    const order = allCardIds();
    if (order !== "") persistOrder(order);
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

  const onAfterRequest = (e: Event): void => {
    const detail = htmxRequestDetail(e);
    if (detail.requestConfig?.path !== "/prompts/new") return;
    if (detail.successful) fillSaveBody();
  };

  // Client-side title/category/body filter with no server round-trip.
  const filterPrompts = (query: string): void => {
    const needle = query.toLowerCase();
    for (const card of document.querySelectorAll<HTMLElement>(
      "[data-prompt-grid] .prompt-card",
    )) {
      const text = (card.textContent ?? "").toLowerCase();
      card.style.display = text.includes(needle) ? "" : "none";
    }
    // In grouped mode, hide sections that have no matching cards.
    for (const group of document.querySelectorAll<HTMLElement>(
      ".prompt-group",
    )) {
      const hasVisible = [
        ...group.querySelectorAll<HTMLElement>(".prompt-card"),
      ].some((card) => card.style.display !== "none");
      group.style.display = hasVisible ? "" : "none";
    }
  };

  // Document-level delegation survives the out-of-band library swaps that
  // saving/editing trigger, mirroring sidebar.ts and rename.ts.
  document.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const btn = el?.closest("[data-action]");
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.dataset.action ?? "";
    if (action === "use") usePrompt(btn);
    else if (action === "run") void runPrompt(btn);
    else if (action === "followup-use") followupUse(btn);
    else if (action === "close-save") closeSaveSlot();
    // "open-save" is handled by htmx; the body pre-fill runs after the swap.
  });

  // Typing in the main textarea detaches it from any saved prompt (drop the
  // prompt-id); typing in the filter narrows the grid client-side.
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el instanceof HTMLTextAreaElement && el.name === "prompt")
      setPromptId("");
    else if (
      el instanceof HTMLInputElement &&
      el.classList.contains("prompt-filter")
    )
      filterPrompts(el.value);
  });

  document.addEventListener("htmx:afterRequest", onAfterRequest);
  document.addEventListener("dragstart", onDragStart);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("drop", onDrop);
  document.addEventListener("dragend", onDragEnd);
})();
