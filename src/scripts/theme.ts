const KEY = "glv-theme";

const apply = (isDark: boolean): void => {
  document.documentElement.classList.toggle("dark", isDark);
  try {
    localStorage.setItem(KEY, isDark ? "dark" : "light");
  } catch {
    /* localStorage unavailable (e.g. private mode) — session only */
  }
};

const toggle = (): void => {
  apply(!document.documentElement.classList.contains("dark"));
};

// Event delegation on `document` survives the out-of-band sidebar swaps
// that archiving triggers.
document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest(".theme-toggle") instanceof HTMLElement) {
    e.preventDefault();
    toggle();
  }
});
