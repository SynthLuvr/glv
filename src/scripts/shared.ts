const parseJson = <T = unknown>(raw: string): T | undefined => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
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

export { fillPromptInput, parseJson };
