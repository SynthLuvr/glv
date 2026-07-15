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

document.querySelector(".theme-toggle")?.addEventListener("click", toggle);
