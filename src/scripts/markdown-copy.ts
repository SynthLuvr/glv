const COPIED_MS = 1500;

// The button is server-rendered inside every `.markdown` block and also arrives
// via htmx swaps and SSE stream lines, so a single document-level delegated
// listener covers all three entry points without re-initialisation.
const copyMarkdown = async (btn: HTMLElement): Promise<void> => {
  const md = btn.dataset.md;
  if (md === undefined) return;
  try {
    await navigator.clipboard.writeText(md);
  } catch {
    // clipboard API unavailable (e.g. non-secure context) — fail silently
    return;
  }
  btn.classList.add("copied");
  window.setTimeout(() => btn.classList.remove("copied"), COPIED_MS);
};

document.addEventListener("click", (e) => {
  const btn =
    e.target instanceof Element ? e.target.closest(".copy-md-btn") : null;
  if (btn instanceof HTMLElement) {
    e.preventDefault();
    void copyMarkdown(btn);
  }
});
