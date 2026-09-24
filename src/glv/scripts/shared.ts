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

export { fillPromptInput, onSessionListSwap, sessionOfBar };
