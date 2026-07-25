const isDebugEnabled = (): boolean =>
  process.env.GLV_DEBUG === "1" || process.env.GLV_DEBUG === "true";

const formatLine = (
  level: "debug" | "warn",
  component: string,
  err: unknown,
): string => {
  const message = err instanceof Error ? err.message : String(err);
  return `[glv:${component}] ${level}: ${message}`;
};

// Benign catches (a process that already exited, a non-repo git query): hidden
// unless GLV_DEBUG is set so they aren't noise, yet observable when triaging.
const debug = (component: string, err: unknown): void => {
  if (!isDebugEnabled()) return;
  console.debug(formatLine("debug", component, err));
};

// Genuinely unexpected failures (e.g. a corrupt DB row): always emitted so
// there is a diagnostic trail even in production.
const warn = (component: string, err: unknown): void => {
  console.warn(formatLine("warn", component, err));
};

export { debug, warn };
