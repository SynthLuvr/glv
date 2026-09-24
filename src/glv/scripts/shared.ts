import { htmxSwapTarget } from "./htmx.js";

// The session id a prompt bar posts to, read from its hx-post attribute;
// undefined for the New Session form (which posts to /sessions) or a
// malformed action.
const sessionOfBar = (bar: Element): string | undefined => {
  const match = /^\/sessions\/([^/]+)\/prompt$/.exec(
    bar.getAttribute("hx-post") ?? "",
  );
  return match === null ? undefined : match[1];
};

// `.value =` doesn't fire `input`; dispatch it so the autogrow listener
// (ui.ts) resizes multi-line prompts instead of leaving them clipped.
const fillPromptInput = (
  el: HTMLTextAreaElement | null,
  value: string,
): void => {
  if (el === null) return;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

// htmx fires `htmx:afterSwap` only for a swap's main target; out-of-band
// swaps — the rename route re-renders the sidebar alongside the title —
// dispatch `htmx:oobAfterSwap` instead. Listen for both so client-side
// session-list state (unread badges, collapsed groups) survives either
// path.
const onSessionListSwap = (apply: () => void): void => {
  for (const eventName of ["htmx:afterSwap", "htmx:oobAfterSwap"])
    document.addEventListener(eventName, (e) => {
      const target = htmxSwapTarget(e);
      if (target !== null && target.id === "session-list") apply();
    });
};

const removeIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

// Shows a transient error in the form's .upload-error element, shared by
// the upload and location flows.
const showError = (container: HTMLElement | null, message: string): void => {
  if (container === null) return;
  container.textContent = message;
  container.style.display = "block";
  window.setTimeout(() => {
    if (container.textContent === message) container.style.display = "none";
  }, 5000);
};

// One attachment chip — an upload's file or the shared location: a thumb,
// a name over a detail line, and a remove button.
const createAttachmentChip = ({
  className,
  thumb,
  name,
  nameTitle,
  detail,
  removeLabel,
  onRemove,
}: {
  className: string;
  thumb: HTMLElement;
  name: string;
  nameTitle?: string;
  detail: string;
  removeLabel: string;
  onRemove: () => void;
}): HTMLElement => {
  const chip = document.createElement("div");
  chip.className = className;
  chip.appendChild(thumb);

  const info = document.createElement("div");
  info.className = "chip-info";

  const nameEl = document.createElement("span");
  nameEl.className = "chip-name";
  nameEl.textContent = name;
  if (nameTitle !== undefined) nameEl.title = nameTitle;
  info.appendChild(nameEl);

  const detailEl = document.createElement("span");
  detailEl.className = "chip-size";
  detailEl.textContent = detail;
  info.appendChild(detailEl);

  chip.appendChild(info);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "chip-remove";
  remove.setAttribute("aria-label", removeLabel);
  remove.innerHTML = removeIcon;
  remove.addEventListener("click", onRemove);
  chip.appendChild(remove);

  return chip;
};

// Wires every [data-upload-form] form — the New Session form and the
// in-session prompt bars hosting the attachment flows (uploads, location
// share) — on load and again as htmx swaps fresh nodes in: detail-pane
// navigation and busy/idle prompt-bar transitions both replace the form
// element. A form that survives a swap is not re-wired; identity-keyed,
// only fresh nodes are. Returns a getter for the session id captured from
// a prompt bar just before it was swapped out, so wire can carry staged
// state across a busy/idle swap; detail-pane navigation resets it so state
// never leaks into another session or the New Session form.
const wireUploadForms = (
  wire: (form: HTMLFormElement) => void,
): (() => string | undefined) => {
  const wired = new WeakSet<HTMLFormElement>();
  let carriedSessionId: string | undefined;

  const wireFreshForms = (): void => {
    for (const form of document.querySelectorAll<HTMLFormElement>(
      "[data-upload-form]",
    )) {
      if (wired.has(form)) continue;
      wired.add(form);
      wire(form);
    }
  };

  document.addEventListener("DOMContentLoaded", wireFreshForms);

  document.body.addEventListener("htmx:beforeSwap", (e) => {
    const target = htmxSwapTarget(e);
    if (target?.hasAttribute("data-prompt-bar"))
      carriedSessionId = sessionOfBar(target);
  });

  document.body.addEventListener("htmx:afterSwap", (e) => {
    const target = htmxSwapTarget(e);
    if (target?.id === "detail-pane") {
      carriedSessionId = undefined;
      wireFreshForms();
      return;
    }
    if (target?.hasAttribute("data-prompt-bar")) wireFreshForms();
  });

  // One-shot: the first fresh form consumes the captured id.
  return () => {
    const carried = carriedSessionId;
    carriedSessionId = undefined;
    return carried;
  };
};

export {
  createAttachmentChip,
  fillPromptInput,
  onSessionListSwap,
  sessionOfBar,
  showError,
  wireUploadForms,
};
