const isDebugEnabled = (): boolean => {
  const flag = process.env.GLV_DEBUG;
  return flag === "1" || flag === "true";
};

// Each line is tagged with the originating component so logs can be grepped by
// subsystem; the message is extracted from any thrown shape.
const formatLine = (
  level: "debug" | "warn",
  component: string,
  err: unknown,
): string => {
  const message = err instanceof Error ? err.message : String(err);
  return `[glv:${component}] ${level}: ${message}`;
};

// The floor for benign-but-noteworthy catches (a process that already exited,
// a non-repo git query): suppressed unless GLV_DEBUG is set so it is not noise
// by default, yet remains observable when triaging an issue.
const debug = (component: string, err: unknown): void => {
  if (!isDebugEnabled()) return;
  console.debug(formatLine("debug", component, err));
};

// Always emitted and reserved for genuinely unexpected failures (e.g. a
// corrupt DB row), so there is a diagnostic trail even in production.
const warn = (component: string, err: unknown): void => {
  console.warn(formatLine("warn", component, err));
};

export { debug, warn };
